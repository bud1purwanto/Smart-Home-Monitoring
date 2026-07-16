// Fitur 4: Action Macros — baris tombol macro + editor modal (tersimpan di KV).
(function () {
  const App = window.App;
  let macros = [];

  // ---- Baris macro ----
  async function refresh() {
    const data = await App.api("/api/macros");
    macros = data.success ? data.macros : [];
    render();
  }

  function render() {
    const bar = document.getElementById("macroBar");
    if (!bar) return;
    bar.className = "macro-bar";
    bar.innerHTML =
      macros
        .map(
          (m) => `
        <button class="macro-btn" onclick="App.Macros.run('${m.id}')">
          ${m.icon || "🎬"} ${escapeHtml(m.name)}
          <span class="edit" onclick="event.stopPropagation();App.Macros.edit('${m.id}')">✏️</span>
        </button>`
        )
        .join("") +
      `<button class="macro-btn add" onclick="App.Macros.edit()">＋ Macro</button>`;
  }

  async function run(id) {
    const bar = document.getElementById("macroBar");
    const res = await App.api("/api/macros/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    // Umpan balik singkat, lalu refresh status device.
    const ok = res.success;
    toast(ok ? `✅ "${res.name}" dijalankan` : `⚠️ "${res.name}" sebagian gagal`);
    setTimeout(() => App.Devices?.render(), 800);
  }

  // ---- Editor modal ----
  async function edit(id) {
    // Pastikan daftar device tersedia untuk picker.
    let devices = App.lastDevices;
    if (!devices?.length) {
      const d = await App.api("/api/devices");
      devices = d.devices || [];
    }
    const existing = macros.find((m) => m.id === id);
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : { id: null, name: "", icon: "🎬", steps: [] };
    openModal(draft, devices);
  }

  function openModal(draft, devices) {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "macroModal";

    const deviceOpts = (sel) =>
      devices
        .map(
          (d) =>
            `<option value="${d.id}" ${d.id === sel ? "selected" : ""}>${escapeHtml(
              d.name || d.id
            )} · ${escapeHtml(d.room || "")}</option>`
        )
        .join("");

    const stepRow = (s = {}) => `
      <div class="step-row">
        <select class="s-device">${deviceOpts(s.deviceId)}</select>
        <select class="s-value">
          <option value="true" ${s.value !== false ? "selected" : ""}>Nyalakan</option>
          <option value="false" ${s.value === false ? "selected" : ""}>Matikan</option>
        </select>
        <button class="del" onclick="this.parentElement.remove()">✕</button>
      </div>`;

    backdrop.innerHTML = `
      <div class="modal">
        <h3>${draft.id ? "Edit" : "Buat"} Macro</h3>
        <div class="row-inline">
          <div>
            <label>Nama</label>
            <input id="m-name" value="${escapeHtml(draft.name)}" placeholder="Mode Tidur" />
          </div>
          <div class="icon-input">
            <label>Ikon</label>
            <input id="m-icon" value="${escapeHtml(draft.icon)}" maxlength="4" />
          </div>
        </div>
        <label>Langkah (device + aksi)</label>
        <div id="m-steps">${(draft.steps.length ? draft.steps : [{}]).map(stepRow).join("")}</div>
        <button class="secondary" style="margin-top:.4rem" onclick="App.Macros._addStep()">+ Tambah langkah</button>
        <div class="modal-actions">
          ${draft.id ? `<button class="danger" onclick="App.Macros._delete('${draft.id}')">Hapus</button>` : ""}
          <button class="secondary" onclick="App.Macros._close()">Batal</button>
          <button onclick="App.Macros._save('${draft.id || ""}')">Simpan</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });
    // Simpan referensi device untuk _addStep.
    openModal._devices = devices;
  }

  function _addStep() {
    const wrap = document.getElementById("m-steps");
    if (!wrap) return;
    const devices = openModal._devices || [];
    const opts = devices
      .map((d) => `<option value="${d.id}">${escapeHtml(d.name || d.id)} · ${escapeHtml(d.room || "")}</option>`)
      .join("");
    const div = document.createElement("div");
    div.className = "step-row";
    div.innerHTML = `
      <select class="s-device">${opts}</select>
      <select class="s-value">
        <option value="true" selected>Nyalakan</option>
        <option value="false">Matikan</option>
      </select>
      <button class="del" onclick="this.parentElement.remove()">✕</button>`;
    wrap.appendChild(div);
  }

  async function _save(id) {
    const name = document.getElementById("m-name").value.trim() || "Macro";
    const icon = document.getElementById("m-icon").value.trim() || "🎬";
    const steps = [...document.querySelectorAll("#m-steps .step-row")].map((row) => ({
      deviceId: row.querySelector(".s-device").value,
      code: deviceSwitchCode(row.querySelector(".s-device").value),
      value: row.querySelector(".s-value").value === "true",
    }));
    const macro = { id: id || undefined, name, icon, steps };
    const others = macros.filter((m) => m.id !== id);
    const next = [...others, macro];
    await App.api("/api/macros", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    closeModal();
    await refresh();
  }

  async function _delete(id) {
    const next = macros.filter((m) => m.id !== id);
    await App.api("/api/macros", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    closeModal();
    await refresh();
  }

  // Tentukan kode switch untuk device dari status terakhirnya (fallback switch_1).
  function deviceSwitchCode(deviceId) {
    const dev = (App.lastDevices || []).find((d) => d.id === deviceId);
    return dev ? App.switchCode(dev.status) : "switch_1";
  }

  function closeModal() {
    document.getElementById("macroModal")?.remove();
  }

  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.style.cssText =
        "position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:#334155;color:#e2e8f0;padding:.6rem 1rem;border-radius:10px;z-index:60;font-size:.9rem;box-shadow:0 4px 12px rgba(0,0,0,.4)";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.opacity = "0"), 2500);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  App.Macros = { refresh, run, edit, _addStep, _save, _delete, _close: closeModal };
})();
