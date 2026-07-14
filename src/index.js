// Worker utama Smart Home Monitoring.
// - fetch(): melayani API internal + serve static assets (frontend).
// - scheduled(): cron tiap 5 menit untuk polling status device & hitung idle alerts.
//
// Frontend HANYA bicara ke worker ini, tidak pernah langsung ke Tuya.
// Secret Tuya (client_id/secret) aman di server, tidak pernah terekspos ke browser.

import {
  getDevicesStatus,
  getDeviceInfo,
  sendCommands,
} from "./tuya.js";
import deviceMap from "../device-map.json";

// Ambil nama/ruangan/ikon ramah untuk sebuah device ID; fallback ke ID mentah kalau tidak ada di map.
function friendlyDevice(id) {
  const meta = deviceMap[id];
  return {
    name: meta?.name || id,
    room: meta?.room || "Tanpa Ruangan",
    icon: meta?.icon || "🔌",
  };
}

const IDLE_STATE_KEY = "idle_state";
const IDLE_ALERTS_KEY = "idle_alerts";

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

async function handleDevices(env) {
  const ids = parseIds(env.DEVICE_IDS);
  const statuses = await getDevicesStatus(env, ids);
  const devices = statuses.map((dev) => ({
    ...dev,
    ...friendlyDevice(dev.id),
  }));
  return json({ success: true, devices });
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
    deviceIds: parseIds(env.DEVICE_IDS),
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

  const statuses = await getDevicesStatus(env, highPower);
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
        const { name } = friendlyDevice(dev.id);
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
        if (pathname === "/api/config" && request.method === "GET") {
          return await handleConfig(env);
        }
        if (pathname === "/api/idle-alerts" && request.method === "GET") {
          return await handleIdleAlerts(env);
        }
        if (pathname === "/api/weather" && request.method === "GET") {
          return await handleWeather(env);
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
    ctx.waitUntil(computeIdleAlerts(env));
  },
};
