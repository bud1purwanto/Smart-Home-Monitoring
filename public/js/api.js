// Helper fetch tunggal ke API internal worker. Semua modul frontend
// HANYA lewat sini (dan tidak pernah langsung ke Tuya).
async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

// Util kecil dipakai lintas modul.
const App = window.App || (window.App = {});
App.api = api;

// Deteksi apakah device menyala dari daftar status-nya.
App.deviceIsOn = function (status) {
  if (!Array.isArray(status)) return false;
  return status.some(
    (s) =>
      ["switch", "switch_1", "Power", "switch_led"].includes(s.code) &&
      s.value === true
  );
};

// Kode datapoint switch utama sebuah device (untuk toggle).
App.switchCode = function (status) {
  const s = (status || []).find((s) =>
    ["switch", "switch_1", "Power", "switch_led"].includes(s.code)
  );
  return s ? s.code : "switch_1";
};

// Apakah device bisa di-toggle (punya switch)? CCTV/sensor tidak.
App.isControllable = function (status) {
  return (status || []).some((s) =>
    ["switch", "switch_1", "Power", "switch_led"].includes(s.code)
  );
};

// Kirim perintah on/off ke satu device.
App.toggleDevice = async function (deviceId, code, turnOn) {
  await api("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, commands: [{ code, value: turnOn }] }),
  });
};
