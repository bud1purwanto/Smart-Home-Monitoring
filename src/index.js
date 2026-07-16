// Worker utama Smart Home Monitoring.
// - fetch(): melayani API internal + serve static assets (frontend).
// - scheduled(): cron tiap 5 menit untuk polling status device & hitung idle alerts.
//
// Frontend HANYA bicara ke worker ini, tidak pernah langsung ke Tuya.
// Secret Tuya (client_id/secret) aman di server, tidak pernah terekspos ke browser.

import {
  getDevicesStatus,
  getDeviceInfo,
  getUserDevices,
  getRoomMap,
  sendCommands,
} from "./tuya.js";
import deviceMap from "../device-map.json";

// device-map.json sekarang jadi OPSIONAL: hanya untuk override "room" & "icon".
// Nama, daftar device, DAN ruangan sudah otomatis dari Tuya (via TUYA_UID + Home/Room API),
// jadi normalnya tidak perlu ketik apa pun manual. Urutan prioritas "room":
//   1. override manual di device-map.json (kalau ada)
//   2. ruangan asli dari app Smart Life (base.tuyaRoom)
//   3. fallback "Tanpa Ruangan"
function applyOverride(id, base) {
  const meta = deviceMap[id];
  return {
    ...base,
    room: meta?.room || base.tuyaRoom || "Tanpa Ruangan",
    icon: meta?.icon || base.icon || "🔌",
  };
}

const IDLE_STATE_KEY = "idle_state";
const IDLE_ALERTS_KEY = "idle_alerts";
const MACROS_KEY = "macros";
const ENERGY_KEY = "energy_history";
const DEVICE_LIST_CACHE_KEY = "device_list";

// Skala datapoint Tuya. cur_power/cur_voltage device ini ×0.1 (verified: cur_voltage 2192 = 219.2V).
const POWER_SCALE = 0.1;
// add_ele = counter energi kumulatif; unit device ini diasumsikan 0.01 kWh/unit (KALIBRASI:
// override via env ENERGY_SCALE kalau angka kWh terlihat meleset). Dipakai untuk konversi unit->kWh.
const DEFAULT_ENERGY_SCALE = 0.01;
const CO2_PER_KWH = 0.85; // faktor emisi grid Indonesia (kg CO2 / kWh), indikatif
const TREE_YEAR_KG = 21; // 1 pohon menyerap ~21 kg CO2 / tahun (indikatif)
const DEFAULT_TARGET_KWH = 30;
const DEVICE_LIST_TTL_SECONDS = 300; // 5 menit — daftar device jarang berubah

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseIds(str) {
  return (str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Deteksi apakah sebuah device "menyala" dari daftar status-nya.
function isDeviceOn(statusList) {
  if (!Array.isArray(statusList)) return false;
  for (const s of statusList) {
    if (
      (s.code === "switch" ||
        s.code === "switch_1" ||
        s.code === "Power" ||
        s.code === "switch_led") &&
      s.value === true
    ) {
      return true;
    }
  }
  return false;
}

// ---- API handlers ----

// Auto-discover: ambil semua device yang ter-link ke akun App Tuya (TUYA_UID),
// termasuk nama & kategori aslinya — tidak perlu ketik Device ID manual.
// Di-cache 5 menit di KV supaya hemat quota (daftar device jarang berubah).
async function getDiscoveredDevices(env) {
  const cached = await env.CACHE.get(DEVICE_LIST_CACHE_KEY, { type: "json" });
  if (cached) return cached;

  if (!env.TUYA_UID) {
    throw new Error(
      "TUYA_UID belum di-set. Isi di .dev.vars / secret Cloudflare (lihat README)."
    );
  }
  // Ambil daftar device + peta ruangan (Smart Life) paralel.
  // Peta ruangan bersifat "best effort": kalau API Home/Room tidak tersedia
  // (mis. project Tuya belum langganan), jangan gagalkan seluruh dashboard —
  // cukup jatuh ke override device-map.json / "Tanpa Ruangan".
  const [list, roomMap] = await Promise.all([
    getUserDevices(env, env.TUYA_UID),
    getRoomMap(env, env.TUYA_UID).catch((err) => {
      console.log("Room map gagal (dilewati):", String(err.message || err));
      return {};
    }),
  ]);
  const enriched = list.map((d) => ({ ...d, tuyaRoom: roomMap[d.id] || null }));
  await env.CACHE.put(DEVICE_LIST_CACHE_KEY, JSON.stringify(enriched), {
    expirationTtl: DEVICE_LIST_TTL_SECONDS,
  });
  return enriched;
}

async function handleDevices(env) {
  const list = await getDiscoveredDevices(env);
  const ids = list.map((d) => d.id);
  const statuses = await getDevicesStatus(env, ids);
  const statusById = Object.fromEntries(statuses.map((s) => [s.id, s.status]));

  const devices = list.map((d) =>
    applyOverride(d.id, {
      id: d.id,
      name: d.name,
      category: d.category,
      online: d.online,
      tuyaRoom: d.tuyaRoom || null,
      status: statusById[d.id] || [],
    })
  );
  return json({ success: true, devices });
}

// Paksa refresh daftar device (dipakai tombol "Sinkronkan" di dashboard
// setelah tambah/pindah/reset device di app Tuya, tanpa perlu redeploy).
async function handleRefreshDevices(env) {
  await env.CACHE.delete(DEVICE_LIST_CACHE_KEY);
  const list = await getDiscoveredDevices(env);
  return json({ success: true, count: list.length });
}

async function handleDeviceInfo(env, deviceId) {
  const info = await getDeviceInfo(env, deviceId);
  return json({ success: true, device: info });
}

async function handleCommand(env, request) {
  const body = await request.json();
  const { deviceId, commands } = body;
  if (!deviceId || !Array.isArray(commands)) {
    return json({ success: false, msg: "deviceId & commands wajib" }, 400);
  }
  const result = await sendCommands(env, deviceId, commands);
  return json(result);
}

// Fitur 6: kembalikan daftar idle alert yang dihitung oleh cron.
async function handleIdleAlerts(env) {
  const alerts = (await env.CACHE.get(IDLE_ALERTS_KEY, { type: "json" })) || [];
  return json({ success: true, alerts });
}

// ---- Fitur 4: Action Macros ----
// Macro = { id, name, icon, steps: [{ deviceId, code, value }] }. Disimpan di KV.

function sanitizeMacros(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.map((m) => ({
    id: String(m.id || crypto.randomUUID()),
    name: String(m.name || "Macro").slice(0, 60),
    icon: String(m.icon || "🎬").slice(0, 8),
    steps: Array.isArray(m.steps)
      ? m.steps
          .filter((s) => s && s.deviceId && s.code)
          .map((s) => ({
            deviceId: String(s.deviceId),
            code: String(s.code),
            value: typeof s.value === "boolean" ? s.value : s.value === "true",
          }))
      : [],
  }));
}

async function handleGetMacros(env) {
  const macros = (await env.CACHE.get(MACROS_KEY, { type: "json" })) || [];
  return json({ success: true, macros });
}

async function handleSaveMacros(env, request) {
  const clean = sanitizeMacros(await request.json());
  if (!clean) return json({ success: false, msg: "Body harus array macro" }, 400);
  await env.CACHE.put(MACROS_KEY, JSON.stringify(clean));
  return json({ success: true, macros: clean });
}

async function handleRunMacro(env, request) {
  const { id } = await request.json();
  const macros = (await env.CACHE.get(MACROS_KEY, { type: "json" })) || [];
  const macro = macros.find((m) => m.id === id);
  if (!macro) return json({ success: false, msg: "Macro tidak ditemukan" }, 404);

  // Jalankan tiap step berurutan; kalau satu gagal, lanjut sisanya & tandai.
  const results = [];
  for (const step of macro.steps) {
    try {
      const r = await sendCommands(env, step.deviceId, [
        { code: step.code, value: step.value },
      ]);
      results.push({ ...step, success: !!r.success, msg: r.msg || null });
    } catch (e) {
      results.push({ ...step, success: false, msg: String(e.message || e) });
    }
  }
  return json({ success: results.every((r) => r.success), name: macro.name, results });
}

// ---- Fitur 3: Gamifikasi Energi (device bermeteran, mis. Water Heater) ----

function statusValue(statusList, code) {
  const s = (statusList || []).find((x) => x.code === code);
  return s ? s.value : null;
}

// Tanggal lokal WIB (UTC+7) sebagai "YYYY-MM-DD" untuk pengelompokan harian/bulanan.
function wibDateStr(ts = Date.now()) {
  return new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function energyDeviceId(env) {
  return env.ENERGY_DEVICE_ID || null;
}

// Dipanggil dari cron: baca counter energi kumulatif (add_ele) device bermeteran,
// hitung konsumsi harian dari delta counter (tahan reset counter & ganti hari).
async function computeEnergy(env) {
  const devId = energyDeviceId(env);
  if (!devId) return;

  const statuses = await getDevicesStatus(env, [devId]);
  const st = statuses[0]?.status;
  if (!st) return;

  const raw = Number(statusValue(st, "add_ele")); // counter kumulatif
  if (!Number.isFinite(raw)) return;
  const powerW = Number(statusValue(st, "cur_power") || 0) * POWER_SCALE;

  const today = wibDateStr();
  const state =
    (await env.CACHE.get(ENERGY_KEY, { type: "json" })) || {
      baseline: {},
      days: {},
      lastRaw: null,
      lastDate: null,
      lastPowerW: 0,
    };

  // Counter reset (nilai turun) → mulai ulang baseline hari ini dari nilai sekarang.
  if (state.lastRaw != null && raw < state.lastRaw) {
    state.baseline[today] = raw;
  }
  if (state.baseline[today] == null) state.baseline[today] = raw;

  state.days[today] = Math.max(0, raw - state.baseline[today]);
  state.lastRaw = raw;
  state.lastDate = today;
  state.lastPowerW = powerW;

  // Buang data > 60 hari biar KV ramping.
  const cutoff = wibDateStr(Date.now() - 60 * 86400 * 1000);
  for (const d of Object.keys(state.days)) if (d < cutoff) delete state.days[d];
  for (const d of Object.keys(state.baseline)) if (d < cutoff) delete state.baseline[d];

  await env.CACHE.put(ENERGY_KEY, JSON.stringify(state));
}

async function handleEnergy(env) {
  const devId = energyDeviceId(env);
  const scale = Number(env.ENERGY_SCALE || DEFAULT_ENERGY_SCALE);
  const targetKwh = Number(env.ENERGY_TARGET_KWH || DEFAULT_TARGET_KWH);
  const state = await env.CACHE.get(ENERGY_KEY, { type: "json" });

  if (!devId || !state || state.lastRaw == null) {
    return json({
      success: true,
      configured: !!devId,
      hasData: false,
      targetKwh,
      liveWatt: state?.lastPowerW || 0,
      kwhToday: 0,
      kwhMonth: 0,
      co2Kg: 0,
      trees: 0,
      progress: 0,
    });
  }

  const today = wibDateStr();
  const month = today.slice(0, 7);
  const unitsToday = state.days[today] || 0;
  const unitsMonth = Object.entries(state.days)
    .filter(([d]) => d.startsWith(month))
    .reduce((sum, [, v]) => sum + v, 0);

  const kwhToday = unitsToday * scale;
  const kwhMonth = unitsMonth * scale;
  const co2Kg = kwhMonth * CO2_PER_KWH;
  const trees = co2Kg / TREE_YEAR_KG;

  return json({
    success: true,
    configured: true,
    hasData: true,
    liveWatt: Math.round(state.lastPowerW || 0),
    kwhToday: Number(kwhToday.toFixed(3)),
    kwhMonth: Number(kwhMonth.toFixed(3)),
    co2Kg: Number(co2Kg.toFixed(2)),
    trees: Number(trees.toFixed(2)),
    targetKwh,
    progress: targetKwh > 0 ? Math.min(1, kwhMonth / targetKwh) : 0,
    underTarget: kwhMonth <= targetKwh,
  });
}

// Fitur 7: cuaca dari Open-Meteo (gratis, tanpa API key). Di-cache 30 menit di KV.
async function handleWeather(env) {
  const cacheKey = "weather";
  const cached = await env.CACHE.get(cacheKey, { type: "json" });
  if (cached) return json({ success: true, weather: cached, cached: true });

  const lat = env.HOME_LATITUDE;
  const lon = env.HOME_LONGITUDE;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code&daily=precipitation_sum&forecast_days=1&timezone=auto`;
  const res = await fetch(url);
  const data = await res.json();

  const isRaining =
    (data.current?.precipitation ?? 0) > 0 ||
    (data.daily?.precipitation_sum?.[0] ?? 0) > 1;
  const weather = {
    temperature: data.current?.temperature_2m,
    precipitation: data.current?.precipitation,
    isRaining,
    // Untuk Fitur 7: kalau hujan, tombol "Siram Taman" dinonaktifkan di UI.
    gardenWateringDisabled: isRaining,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(weather), {
    expirationTtl: 1800,
  });
  return json({ success: true, weather });
}

async function handleConfig(env) {
  // Info non-rahasia yang dibutuhkan frontend.
  return json({
    success: true,
    highPowerDeviceIds: parseIds(env.HIGH_POWER_DEVICE_IDS),
    idleLimitMinutes: Number(env.IDLE_LIMIT_MINUTES || 60),
  });
}

// ---- Cron: hitung idle alerts (Fitur 6) ----
// Polling status high-power device, catat "nyala sejak kapan" di KV,
// dan tandai alert kalau nyala melewati batas.
async function computeIdleAlerts(env) {
  const highPower = parseIds(env.HIGH_POWER_DEVICE_IDS);
  if (highPower.length === 0) return;

  const limitMs = Number(env.IDLE_LIMIT_MINUTES || 60) * 60 * 1000;
  const now = Date.now();

  const [statuses, discovered] = await Promise.all([
    getDevicesStatus(env, highPower),
    getDiscoveredDevices(env),
  ]);
  const nameById = Object.fromEntries(discovered.map((d) => [d.id, d.name]));
  const state =
    (await env.CACHE.get(IDLE_STATE_KEY, { type: "json" })) || {};
  const alerts = [];

  for (const dev of statuses) {
    const on = isDeviceOn(dev.status);
    if (on) {
      // Catat waktu mulai nyala kalau belum tercatat.
      if (!state[dev.id]) state[dev.id] = now;
      const onSince = state[dev.id];
      if (now - onSince >= limitMs) {
        const minutesOn = Math.round((now - onSince) / 60000);
        const name = nameById[dev.id] || dev.id;
        alerts.push({
          deviceId: dev.id,
          onSince,
          minutesOn,
          message: `${name} sudah menyala ${minutesOn} menit — cek agar tidak boros listrik.`,
        });
      }
    } else {
      // Reset kalau sudah mati.
      delete state[dev.id];
    }
  }

  await env.CACHE.put(IDLE_STATE_KEY, JSON.stringify(state));
  await env.CACHE.put(IDLE_ALERTS_KEY, JSON.stringify(alerts));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        if (pathname === "/api/devices" && request.method === "GET") {
          return await handleDevices(env);
        }
        if (pathname === "/api/devices/refresh" && request.method === "POST") {
          return await handleRefreshDevices(env);
        }
        if (pathname === "/api/config" && request.method === "GET") {
          return await handleConfig(env);
        }
        if (pathname === "/api/macros" && request.method === "GET") {
          return await handleGetMacros(env);
        }
        if (pathname === "/api/macros" && request.method === "PUT") {
          return await handleSaveMacros(env, request);
        }
        if (pathname === "/api/macros/run" && request.method === "POST") {
          return await handleRunMacro(env, request);
        }
        if (pathname === "/api/idle-alerts" && request.method === "GET") {
          return await handleIdleAlerts(env);
        }
        if (pathname === "/api/weather" && request.method === "GET") {
          return await handleWeather(env);
        }
        if (pathname === "/api/energy" && request.method === "GET") {
          return await handleEnergy(env);
        }
        if (pathname === "/api/command" && request.method === "POST") {
          return await handleCommand(env, request);
        }
        const infoMatch = pathname.match(/^\/api\/device\/([^/]+)$/);
        if (infoMatch && request.method === "GET") {
          return await handleDeviceInfo(env, infoMatch[1]);
        }
        return json({ success: false, msg: "Not found" }, 404);
      }

      // Selain /api/*, serve frontend statis.
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ success: false, msg: String(err.message || err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Tiap task cron di-guard sendiri: kegagalan satu (mis. HIGH_POWER_DEVICE_IDS
    // belum diisi Device ID valid) tidak boleh mematikan task lainnya.
    const safe = (p, label) =>
      Promise.resolve(p).catch((e) =>
        console.log(`cron ${label} gagal:`, String(e.message || e))
      );
    ctx.waitUntil(
      Promise.all([
        safe(computeIdleAlerts(env), "idle-alerts"),
        safe(computeEnergy(env), "energy"),
      ])
    );
  },
};
