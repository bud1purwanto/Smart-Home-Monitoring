# Desain: Fitur 1–4 Dashboard Smart Home (Tuya x Cloudflare Workers)

Tanggal: 2026-07-16
Status: Disetujui (brainstorming)

## Konteks

Dashboard sudah berjalan di Cloudflare Workers (`src/index.js`) dengan client Tuya
(`src/tuya.js`), cache KV (binding `CACHE`), auto-discovery device via `TUYA_UID`, dan
auto-ruangan dari Home/Room API Smart Life. Frontend saat ini satu file `public/index.html`
serba-inline. Dokumen ini menambah 4 fitur baru.

## Keputusan brainstorming

- **Fitur 1 (Digital Twin):** denah skematik otomatis dari daftar ruangan (bukan floor plan asli, tanpa aset upload).
- **Fitur 3 (Gamifikasi Energi):** fokus device bermeteran — hanya Water Heater (`ebbee322b2f85c77e7bb0t`) yang melaporkan `cur_power` + `add_ele`.
- **Fitur 4 (Action Macros):** editor macro di UI, tersimpan di KV.
- **Frontend:** dipecah modular (`public/js/*.js`), navigasi tab. Tidak pakai framework/build step.

## Arsitektur

- Backend Workers menambah route: `/api/macros` (GET, PUT), `/api/macros/run` (POST), `/api/energy` (GET).
- Cron 5-menit yang sudah ada diperluas: snapshot energi Water Heater ke KV.
- Penyimpanan: KV saja (macro list + histori energi harian). Tidak ada DB baru.
- Frontend: `index.html` ramping + modul JS terpisah, dimuat sebagai static assets (binding `ASSETS`).

### Struktur frontend baru

```
public/
  index.html          # shell + tab nav + container tiap fitur
  js/
    api.js            # helper fetch ke /api/*
    devices.js        # tab "Daftar" (grid device — logika lama dipindah ke sini)
    twin.js           # Fitur 1 — tab "Denah"
    adaptive.js       # Fitur 2 — panel Saran
    energy.js         # Fitur 3 — tab "Energi"
    macros.js         # Fitur 4 — baris macro + editor
    app.js            # bootstrap, tab switching, polling terpusat
```

Tab: **Denah · Daftar · Energi**. Baris Macro & panel Saran (Adaptif) selalu tampil di atas.

## Fitur 1 — Digital Twin (denah skematik)

- Tab "Denah": SVG di-generate dari device (`/api/devices`) dikelompokkan per `dev.room`.
- Tiap ruangan = kotak berlabel; device = ikon/titik di dalam kotak; warna hijau = menyala.
- Layout kotak: grid auto-packing (CSS grid / kalkulasi kolom), bukan denah spasial presisi.
- Klik device → toggle via `/api/command` (sudah ada). Ruangan "Tanpa Ruangan" jadi satu kotak.
- Device tanpa switch (CCTV, sensor) tampil sebagai indikator status saja (tidak bisa toggle).

## Fitur 2 — Adaptive UI

- Panel "Saran" di atas dashboard, berubah menurut waktu lokal + cuaca (`/api/weather`).
- Segmen waktu: pagi (05–11), siang (11–15), sore (15–18), malam (18–05).
- Tiap konteks memunculkan quick-action relevan + sapaan. Contoh:
  - Malam: "Lampu Tidur", "Matikan TV & Ruang Tamu", status CCTV/sensor pintu.
  - Pagi: ringkasan cuaca, "Siram Taman" (nonaktif kalau hujan).
- Pemilihan device per konteks: heuristik berdasar kategori (`dj` lampu, `sp` cctv, dll) & nama/ruangan.
- Murni frontend (baca `/api/devices` + `/api/weather`), tidak perlu route baru.

## Fitur 3 — Gamifikasi Energi (Water Heater)

- **Backend cron:** tiap run, baca status Water Heater; ambil `cur_power` (live) & `add_ele` (kWh kumulatif).
  Simpan snapshot harian di KV: `energy_history` = `{ "YYYY-MM-DD": kwhKumulatifAwalHari, ... }`.
  Hitung kWh terpakai = kumulatif sekarang − kumulatif awal hari/bulan.
- **Kalibrasi unit:** faktor skala `cur_power`/`add_ele` Tuya (sering ×0.1 atau Wh) dibuat konfigurable
  lewat konstanta (`POWER_SCALE`, `ENERGY_SCALE`) — dikalibrasi empiris saat implementasi, tidak di-hardcode buta.
- **Route `/api/energy`:** kembalikan `{ liveWatt, kwhToday, kwhMonth, co2Kg, trees, targetKwh, progress }`.
- Konversi: CO₂ ≈ kWh × 0.85 kg (faktor grid ID, konfigurable). Pohon ≈ CO₂ / 21 kg-per-pohon-per-tahun (indikatif).
- **UI tab "Energi":** watt live, kWh bulan ini, jumlah pohon, progress bar target. Confetti saat milestone tercapai.
- Target bulanan default (mis. 30 kWh) — konfigurable via `[vars]` / config frontend.

## Fitur 4 — Action Macros + Editor UI

- **Data:** macro = `{ id, name, icon, steps: [{ deviceId, code, value }] }`. List disimpan di KV key `macros`.
- **Route:**
  - `GET /api/macros` → daftar macro.
  - `PUT /api/macros` → simpan seluruh daftar (body: array macro).
  - `POST /api/macros/run` → body `{ id }`; jalankan tiap step berurutan via `sendCommands`, kembalikan hasil per step.
- **UI:** baris tombol macro (klik = run). Tombol "＋" buka modal editor: input nama/ikon, tambah langkah
  (pilih device dari `/api/devices`, pilih aksi on/off), simpan → `PUT /api/macros`.
- Validasi: `deviceId` harus ada di daftar device; `value` boolean; abaikan step invalid saat run (laporkan).

## Error handling

- Semua route baru dibungkus try/catch global yang sudah ada (`fetch` handler) → balikan `{success:false, msg}` + status 500.
- `/api/energy`: kalau Water Heater offline / tak ada data, balikan `liveWatt:0` + histori terakhir (jangan error).
- `/api/macros/run`: kumpulkan hasil tiap step; kalau satu step gagal, lanjut step lain & tandai gagal (jangan batalkan semua).
- Kalibrasi energi salah → tampil angka aneh, bukan crash; faktor skala mudah dikoreksi.

## Testing

- **Backend (lokal `wrangler dev` + curl):**
  - Macros: PUT daftar → GET verifikasi → POST run → cek command terkirim.
  - Energy: GET `/api/energy` mengembalikan struktur benar; simulasi histori KV.
- **Frontend (browser lokal):** render denah per ruangan, pindah tab, editor macro simpan & jalan,
  panel adaptif berubah per waktu, confetti muncul saat milestone.
- Regresi: fitur lama (daftar device, idle alerts, cuaca, sinkron) tetap jalan.

## Urutan implementasi (bertahap)

0. Modularisasi frontend (pindah logika lama ke modul, tanpa ubah perilaku) — fondasi.
1. Fitur 4 — Macros (backend + UI editor).
2. Fitur 1 — Denah.
3. Fitur 2 — Adaptif.
4. Fitur 3 — Energi (cron + route + UI + confetti).

Tiap tahap: implement → tes lokal → commit → lanjut.

## Di luar cakupan (YAGNI)

- Denah spasial presisi / 3D (Three.js).
- Metering energi untuk device tanpa sensor daya (estimasi).
- Multi-user / auth macro.
- Push realtime (tetap polling 30 detik seperti sekarang).
