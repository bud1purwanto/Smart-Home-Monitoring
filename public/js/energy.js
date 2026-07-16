// Fitur 3: Gamifikasi Energi — tab "Energi" (watt live, kWh, CO2, pohon,
// progress target) + confetti saat hemat. Data dari /api/energy; watt live
// diambil dari status device terbaru bila ada (lebih segar dari cron).
(function () {
  const App = window.App;
  const POWER_SCALE = 0.1; // selaras backend (cur_power ×0.1 -> watt)
  let last = null;

  function liveWattFromDevices(fallback) {
    const wh = (App.lastDevices || []).find((d) =>
      (d.status || []).some((s) => s.code === "cur_power")
    );
    if (!wh) return fallback;
    const p = (wh.status || []).find((s) => s.code === "cur_power");
    return p ? Math.round(Number(p.value) * POWER_SCALE) : fallback;
  }

  async function refresh() {
    const data = await App.api("/api/energy");
    if (!data.success) return;
    last = data;
    render(data);
  }

  function render(data) {
    const el = document.getElementById("energy");
    if (!el) return;

    if (!data.configured) {
      el.innerHTML =
        '<div class="placeholder">Fitur energi belum dikonfigurasi (set ENERGY_DEVICE_ID).</div>';
      return;
    }

    const liveWatt = liveWattFromDevices(data.liveWatt);
    const pct = Math.round((data.progress || 0) * 100);
    const over = !data.underTarget;

    el.className = "";
    el.innerHTML = `
      <div class="energy-hero">
        <div class="energy-card">
          <div class="big">${liveWatt} W</div>
          <div class="lbl">Daya saat ini</div>
        </div>
        <div class="energy-card">
          <div class="big">${data.kwhToday} kWh</div>
          <div class="lbl">Hari ini</div>
        </div>
        <div class="energy-card">
          <div class="big">${data.kwhMonth} kWh</div>
          <div class="lbl">Bulan ini · ${data.co2Kg} kg CO₂</div>
        </div>
        <div class="energy-card trees">
          <div class="big">🌳 ${data.trees}</div>
          <div class="lbl">pohon setara menyerap CO₂-mu</div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill ${over ? "over" : ""}" style="width:${Math.min(100, pct)}%"></div>
        </div>
        <div class="progress-label">${data.kwhMonth} / ${data.targetKwh} kWh target bulan ini (${pct}%)</div>
      </div>
      <div class="energy-msg ${data.underTarget ? "good" : ""}">
        ${
          !data.hasData
            ? "Belum ada data konsumsi — menunggu polling cron pertama."
            : data.underTarget
            ? "✅ Hemat! Konsumsi masih di bawah target bulan ini."
            : "⚠️ Konsumsi sudah melewati target bulan ini."
        }
      </div>
      <div class="energy-note">Sumber: device bermeteran (Water Heater). CO₂ ≈ kWh × 0.85 kg;
        pohon indikatif (÷21 kg/tahun). Angka kWh bergantung kalibrasi ENERGY_SCALE.</div>`;
  }

  // ---- Confetti ringan (tanpa library, sesuai CSP) ----
  function confetti() {
    const colors = ["#38bdf8", "#22c55e", "#f59e0b", "#e879f9", "#f43f5e"];
    for (let i = 0; i < 80; i++) {
      const p = document.createElement("div");
      p.className = "confetti-piece";
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      const dur = 2 + Math.random() * 2;
      p.style.animation = `confetti-fall ${dur}s linear ${Math.random() * 0.5}s forwards`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), (dur + 1) * 1000);
    }
  }

  // Selebrasi sekali per hari saat membuka tab Energi dalam kondisi hemat.
  function maybeCelebrate() {
    if (!last || !last.hasData || !last.underTarget) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem("energyCelebrated") === today) return;
    localStorage.setItem("energyCelebrated", today);
    confetti();
  }

  document.addEventListener("tab:changed", (e) => {
    if (e.detail === "energi") {
      if (last) render(last);
      maybeCelebrate();
    }
  });
  document.addEventListener("devices:loaded", () => {
    if (last) render(last); // perbarui watt live saat status device baru
  });

  App.Energy = { refresh, _confetti: confetti };
})();
