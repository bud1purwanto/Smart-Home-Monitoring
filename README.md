# 🏠 Smart-Home-Monitoring

Dashboard Smart Home berbasis **Tuya Cloud API** yang di-deploy di **Cloudflare Workers** — dirancang agar jalan di **free tier** (tanpa fitur berbayar Tuya seperti Pulsar/webhook atau streaming CCTV).

## ✨ Fitur

| Fitur | Status | Catatan |
|-------|--------|---------|
| Kontrol & monitor device (nyala/mati) | ✅ | via `get-status-multi` (hemat quota) |
| **Idle Alerts** (Water Heater/AC nyala > batas) | ✅ | Cron tiap 5 menit + state di KV |
| **Pet & Garden Care** (cek cuaca) | ✅ | Open-Meteo, gratis tanpa API key |
| Media Center / kontrol umum device | ✅ | via endpoint command |
| CCTV auto-pop-up real-time berbasis event | ❌ | butuh Tuya Pulsar (berbayar) — disederhanakan jadi refresh polling |

## 🏗️ Arsitektur

```
Browser (public/index.html)
   │  hanya bicara ke /api/*  (tidak pernah langsung ke Tuya)
   ▼
Cloudflare Worker (src/index.js)
   ├── fetch()      → API internal + serve frontend statis
   ├── scheduled()  → cron 5 menit: hitung idle alerts
   └── src/tuya.js  → signing HMAC-SHA256 + cache token
   │
   ├── KV (CACHE)   → access token (cache 1.5 jam), state idle, cache cuaca
   └── Secrets      → TUYA_CLIENT_ID, TUYA_CLIENT_SECRET (tidak pernah ke browser)
```

Kunci rahasia Tuya **tidak pernah** dikirim ke browser. Semua signing terjadi di server.

## 🔑 Kredensial / Environment Variables

Rahasia **tidak** ditaruh di kode. Untuk dev lokal pakai file `.dev.vars` (setara `.env`, sudah di-`.gitignore`), untuk produksi pakai **Cloudflare Secrets**.

1. Salin template:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
2. Isi `.dev.vars` dengan kredensial dari **Tuya IoT Platform → Cloud → project kamu → Overview**.

Variabel:

| Nama | Rahasia? | Keterangan |
|------|----------|------------|
| `TUYA_CLIENT_ID` | ya | Access ID Tuya |
| `TUYA_CLIENT_SECRET` | **ya** | Access Secret Tuya |
| `TUYA_BASE_URL` | tidak | endpoint region (mis. `https://openapi.tuyaus.com`) |
| `DEVICE_IDS` | tidak | device yang dimonitor, dipisah koma |
| `HIGH_POWER_DEVICE_IDS` | tidak | device untuk idle alerts (Water Heater, AC) |
| `IDLE_LIMIT_MINUTES` | tidak | batas idle (default 60) |
| `HOME_LATITUDE` / `HOME_LONGITUDE` | tidak | koordinat untuk cek cuaca |

## 🚀 Setup & Jalankan Lokal

```bash
npm install

# Buat KV namespace (sekali saja), lalu salin id-nya ke wrangler.toml
npx wrangler kv namespace create CACHE

# Jalankan lokal (wrangler otomatis baca .dev.vars)
npm run dev
```

### 🏷️ Nama Ramah Device

Edit `device-map.json` (bukan rahasia, aman di-commit) untuk memetakan Device ID Tuya ke nama, ruangan, dan ikon yang tampil di dashboard:

```json
{
  "eb1234567890abcdef": { "name": "Lampu Ruang Tamu", "room": "Ruang Tamu", "icon": "💡" }
}
```

Device ID yang tidak ada di map tetap tampil (pakai ID mentah sebagai nama), jadi tidak wajib diisi semua sekaligus.

## ☁️ Deploy ke Cloudflare (pakai Secret)

Saat deploy, **jangan** commit rahasia. Set sebagai secret di Cloudflare:

```bash
# 1. Pastikan id KV di wrangler.toml sudah diisi (dari langkah setup)

# 2. Set secret Tuya (nilainya tidak tersimpan di repo)
npx wrangler secret put TUYA_CLIENT_ID
npx wrangler secret put TUYA_CLIENT_SECRET

# 3. (Opsional) set variabel non-rahasia sebagai secret juga bila mau
npx wrangler secret put DEVICE_IDS
npx wrangler secret put HIGH_POWER_DEVICE_IDS

# 4. Deploy
npm run deploy
```

> Alternatif via dashboard: **Workers & Pages → project → Settings → Variables and Secrets → Add** (pilih tipe *Secret* untuk `TUYA_CLIENT_SECRET`).

Cron trigger (idle alerts) otomatis aktif setelah deploy sesuai `wrangler.toml`.

## 📁 Struktur

```
├── public/index.html      # Frontend dashboard
├── src/index.js           # Worker: routing API + cron scheduled()
├── src/tuya.js            # Tuya client: signing + cache token
├── wrangler.toml          # Config Workers (assets, KV, cron)
├── .dev.vars.example      # Template env (salin ke .dev.vars)
└── .gitignore
```
