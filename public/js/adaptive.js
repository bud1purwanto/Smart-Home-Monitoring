// Fitur 2: Adaptive UI — panel "Saran" yang berubah menurut waktu & cuaca.
// Murni frontend: baca App.lastDevices + App.lastWeather.
(function () {
  const App = window.App;
  let actions = []; // {label, ghost, disabled, fn}

  function segment(h) {
    if (h >= 5 && h < 11) return "pagi";
    if (h >= 11 && h < 15) return "siang";
    if (h >= 15 && h < 18) return "sore";
    return "malam";
  }

  const GREET = {
    pagi: "☀️ Selamat pagi",
    siang: "🌤️ Selamat siang",
    sore: "🌆 Selamat sore",
    malam: "🌙 Selamat malam",
  };

  // ---- Helper pemilihan device ----
  function devices() {
    return App.lastDevices || [];
  }
  function byName(sub) {
    const q = sub.toLowerCase();
    return devices().filter((d) => (d.name || "").toLowerCase().includes(q));
  }
  function lamps() {
    return devices().filter(
      (d) =>
        d.category === "dj" ||
        /lampu/i.test(d.name || "") ||
        (d.status || []).some((s) => s.code === "switch_led")
    );
  }

  // ---- Aksi ----
  async function setDevices(list, on) {
    for (const d of list) {
      if (App.isControllable(d.status) && App.deviceIsOn(d.status) !== on) {
        await App.toggleDevice(d.id, App.switchCode(d.status), on);
      }
    }
    setTimeout(() => App.Devices?.render(), 1000);
  }

  // ---- Bangun saran per konteks ----
  function build() {
    const devs = devices();
    const weather = App.lastWeather;
    const seg = segment(new Date().getHours());
    actions = [];

    const lampsOnCount = lamps().filter((d) => App.deviceIsOn(d.status)).length;
    const lampuTidur = byName("lampu tidur");
    const siram = byName("siram");

    if (seg === "malam") {
      if (lampuTidur.length)
        actions.push({ label: "🌙 Nyalakan Lampu Tidur", fn: () => setDevices(lampuTidur, true) });
      if (lampsOnCount > 0)
        actions.push({ label: `💡 Matikan semua lampu (${lampsOnCount})`, ghost: true, fn: () => setDevices(lamps(), false) });
    } else if (seg === "pagi") {
      if (lampuTidur.some((d) => App.deviceIsOn(d.status)))
        actions.push({ label: "🌞 Matikan Lampu Tidur", ghost: true, fn: () => setDevices(lampuTidur, false) });
      if (siram.length) {
        const rain = weather?.isRaining;
        actions.push({
          label: rain ? "💧 Siram Taman (hujan — nonaktif)" : "💧 Siram Taman",
          disabled: !!rain,
          fn: () => setDevices(siram, true),
        });
      }
    } else {
      // siang / sore
      if (lampsOnCount > 0)
        actions.push({ label: `💡 Matikan semua lampu (${lampsOnCount})`, ghost: true, fn: () => setDevices(lamps(), false) });
    }

    // ---- Catatan konteks ----
    let note = "";
    let warn = false;
    if (weather) {
      note = weather.isRaining
        ? `🌧️ Hujan · ${weather.temperature ?? "-"}°C`
        : `☀️ Cerah · ${weather.temperature ?? "-"}°C`;
    }
    // Malam: cek keamanan (pintu/garasi terbuka).
    if (seg === "malam") {
      const openDoors = devs
        .filter((d) => (d.status || []).some((s) => s.code === "doorcontact_state" && s.value === true))
        .map((d) => d.name);
      const cctvOnline = devs.filter((d) => d.category === "sp" && d.online).length;
      if (openDoors.length) {
        note = `⚠️ Terbuka: ${openDoors.join(", ")}`;
        warn = true;
      } else {
        note = `🛡️ Aman · ${cctvOnline} CCTV online · pintu tertutup`;
      }
    }
    return { seg, note, warn };
  }

  function render() {
    const el = document.getElementById("adaptive");
    if (!el) return;
    if (!devices().length) {
      el.innerHTML = "";
      return;
    }
    const { seg, note, warn } = build();
    el.innerHTML = `
      <div class="adaptive-panel">
        <div class="greet">${GREET[seg]}</div>
        <div class="adaptive-actions">
          ${actions
            .map(
              (a, i) =>
                `<button class="${a.ghost ? "ghost" : ""}" ${a.disabled ? "disabled" : ""}
                   onclick="App.Adaptive._run(${i})">${a.label}</button>`
            )
            .join("") || '<span class="context-note">Tidak ada saran khusus saat ini.</span>'}
        </div>
        ${note ? `<div class="context-note ${warn ? "warn" : ""}">${note}</div>` : ""}
      </div>`;
  }

  function _run(i) {
    actions[i]?.fn?.();
  }

  document.addEventListener("devices:loaded", render);
  document.addEventListener("weather:loaded", render);

  App.Adaptive = { refresh: render, _run };
})();
