// Fitur 1: Digital Twin — denah skematik. Ruangan jadi kotak, device jadi chip
// di dalam ruangannya. Layout auto-packing (bukan denah spasial presisi).
(function () {
  const App = window.App;

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function chipHtml(dev) {
    const on = App.deviceIsOn(dev.status);
    const controllable = App.isControllable(dev.status);
    const cls = [
      "chip",
      on ? "on" : "",
      controllable ? "clickable" : "",
      dev.online === false ? "offline" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const onclick = controllable
      ? `onclick="App.Twin.toggle('${dev.id}')"`
      : "";
    return `<span class="${cls}" ${onclick} title="${escapeHtml(dev.name)}">
      <span class="cdot"></span>${dev.icon || "🔌"} ${escapeHtml(dev.name || dev.id)}
    </span>`;
  }

  function render(devices) {
    const el = document.getElementById("twin");
    if (!el) return;
    const list = devices || App.lastDevices || [];
    if (!list.length) {
      el.innerHTML = '<div class="placeholder">Belum ada device.</div>';
      return;
    }
    // Kelompokkan per ruangan.
    const byRoom = {};
    for (const d of list) {
      const room = d.room || "Tanpa Ruangan";
      (byRoom[room] = byRoom[room] || []).push(d);
    }
    // "Tanpa Ruangan" ditaruh paling akhir.
    const rooms = Object.keys(byRoom).sort((a, b) => {
      if (a === "Tanpa Ruangan") return 1;
      if (b === "Tanpa Ruangan") return -1;
      return a.localeCompare(b, "id");
    });
    el.className = "";
    el.innerHTML = `<div class="twin-grid">${rooms
      .map((room) => {
        const devs = byRoom[room];
        const onCount = devs.filter((d) => App.deviceIsOn(d.status)).length;
        return `<div class="room">
          <div class="room-title">${escapeHtml(room)} · ${onCount}/${devs.length} nyala</div>
          <div class="room-devices">${devs.map(chipHtml).join("")}</div>
        </div>`;
      })
      .join("")}</div>`;
  }

  async function toggle(deviceId) {
    const dev = (App.lastDevices || []).find((d) => d.id === deviceId);
    if (!dev) return;
    const on = App.deviceIsOn(dev.status);
    await App.toggleDevice(deviceId, App.switchCode(dev.status), !on);
    setTimeout(() => App.Devices?.render(), 800); // memicu devices:loaded -> render ulang denah
  }

  // Re-render saat data device baru datang atau saat tab Denah dibuka.
  document.addEventListener("devices:loaded", (e) => render(e.detail));
  document.addEventListener("tab:changed", (e) => {
    if (e.detail === "denah") render();
  });

  App.Twin = { render, toggle };
})();
