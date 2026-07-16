// Bootstrap dashboard: jam, cuaca, idle-alerts, tab switching, polling terpusat.
(function () {
  const App = window.App;

  // ---- Jam ----
  function tick() {
    const el = document.getElementById("clock");
    if (el) el.textContent = new Date().toLocaleTimeString("id-ID");
  }
  setInterval(tick, 1000);
  tick();

  // ---- Idle alerts (Fitur 6) ----
  async function loadAlerts() {
    const data = await App.api("/api/idle-alerts");
    const el = document.getElementById("alerts");
    if (!el) return;
    el.innerHTML =
      data.success && data.alerts?.length
        ? data.alerts.map((a) => `<div class="alert">⚠️ ${a.message}</div>`).join("")
        : "";
  }

  // ---- Cuaca (Fitur 7) ----
  async function loadWeather() {
    try {
      const data = await App.api("/api/weather");
      const el = document.getElementById("weather");
      if (!el || !data.success) return;
      const w = data.weather;
      App.lastWeather = w;
      el.innerHTML = `
        <div class="weather">
          <span>${w.isRaining ? "🌧️ Hujan" : "☀️ Cerah"}</span>
          <span>${w.temperature ?? "-"}°C</span>
          <span>💧 Siram Taman: ${
            w.gardenWateringDisabled ? "dinonaktifkan (hujan)" : "aktif"
          }</span>
        </div>`;
      document.dispatchEvent(new CustomEvent("weather:loaded", { detail: w }));
    } catch (e) {
      /* abaikan */
    }
  }

  // ---- Tab switching ----
  function initTabs() {
    const tabs = document.querySelectorAll("[data-tab]");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.tab;
        document
          .querySelectorAll("[data-panel]")
          .forEach((p) => (p.hidden = p.dataset.panel !== name));
        tabs.forEach((t) => t.classList.toggle("active", t === btn));
        document.dispatchEvent(new CustomEvent("tab:changed", { detail: name }));
      });
    });
  }

  // ---- Refresh terpusat ----
  function refreshAll() {
    App.Devices?.render();
    loadAlerts();
    loadWeather();
    App.Adaptive?.refresh?.();
    App.Macros?.refresh?.();
    App.Energy?.refresh?.();
  }
  App.refreshAll = refreshAll;

  // ---- Sinkron manual ----
  function initSync() {
    const btn = document.getElementById("syncBtn");
    if (!btn) return;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      btn.textContent = "🔄 Menyinkronkan…";
      await App.api("/api/devices/refresh", { method: "POST" });
      await App.Devices?.render();
      btn.textContent = "🔄 Sinkronkan device";
    });
  }

  // ---- Init ----
  initTabs();
  initSync();
  refreshAll();
  setInterval(refreshAll, 30000);
})();
