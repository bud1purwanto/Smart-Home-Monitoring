// Tab "Daftar": grid semua device dengan tombol on/off.
(function () {
  const App = window.App;

  function cardHtml(dev) {
    const on = App.deviceIsOn(dev.status);
    const controllable = App.isControllable(dev.status);
    const code = App.switchCode(dev.status);
    const button = controllable
      ? `<button class="${on ? "off" : ""}"
           onclick="App.Devices.toggle('${dev.id}', '${code}', ${!on})">
           ${on ? "Matikan" : "Nyalakan"}
         </button>`
      : `<span class="muted-note">tanpa kontrol on/off</span>`;
    return `
      <div class="card">
        <div class="device-name">${dev.icon || "🔌"} ${dev.name || dev.id}</div>
        <div class="device-id">${dev.room || ""}</div>
        <div class="status-row">
          <span class="dot ${on ? "on" : ""}"></span>
          <span>${on ? "Menyala" : "Mati"}</span>
        </div>
        ${button}
      </div>`;
  }

  async function render() {
    const data = await App.api("/api/devices");
    const el = document.getElementById("devices");
    if (!el) return;
    if (!data.success || !data.devices?.length) {
      el.innerHTML =
        '<div class="loading">Tidak ada perangkat / cek konfigurasi TUYA_UID.</div>';
      return;
    }
    App.lastDevices = data.devices; // dipakai modul lain (denah, adaptif, macro)
    el.innerHTML = data.devices.map(cardHtml).join("");
    document.dispatchEvent(new CustomEvent("devices:loaded", { detail: data.devices }));
  }

  async function toggle(deviceId, code, turnOn) {
    await App.toggleDevice(deviceId, code, turnOn);
    setTimeout(render, 800);
  }

  App.Devices = { render, toggle };
})();
