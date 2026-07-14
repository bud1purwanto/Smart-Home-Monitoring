// Tuya Cloud API client untuk Cloudflare Workers.
// Menangani signing (HMAC-SHA256) sesuai protokol Tuya + caching access token di KV.
// Referensi signature: https://developer.tuya.com/en/docs/iot/api-request

const TOKEN_CACHE_KEY = "tuya_access_token";

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

async function hmacSha256Upper(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return toHex(sig).toUpperCase();
}

// Membangun "stringToSign" bagian dari signature Tuya.
async function buildStringToSign(method, path, body) {
  const bodyHash = await sha256Hex(body || "");
  // method \n contentSHA256 \n headers \n url
  return `${method}\n${bodyHash}\n\n${path}`;
}

// Signature untuk request token (tanpa access_token).
async function signTokenRequest(env, method, path, t, nonce, body) {
  const stringToSign = await buildStringToSign(method, path, body);
  const str = env.TUYA_CLIENT_ID + t + nonce + stringToSign;
  return hmacSha256Upper(str, env.TUYA_CLIENT_SECRET);
}

// Signature untuk request bisnis (dengan access_token).
async function signBusinessRequest(env, accessToken, method, path, t, nonce, body) {
  const stringToSign = await buildStringToSign(method, path, body);
  const str = env.TUYA_CLIENT_ID + accessToken + t + nonce + stringToSign;
  return hmacSha256Upper(str, env.TUYA_CLIENT_SECRET);
}

// Ambil access token: pakai cache KV kalau masih valid, kalau tidak minta baru.
async function getAccessToken(env) {
  const cached = await env.CACHE.get(TOKEN_CACHE_KEY, { type: "json" });
  if (cached && cached.token && cached.expireAt > Date.now()) {
    return cached.token;
  }

  const path = "/v1.0/token?grant_type=1";
  const method = "GET";
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = await signTokenRequest(env, method, path, t, nonce, "");

  const res = await fetch(env.TUYA_BASE_URL + path, {
    method,
    headers: {
      client_id: env.TUYA_CLIENT_ID,
      sign,
      t,
      sign_method: "HMAC-SHA256",
      nonce,
    },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Tuya token error: ${data.msg || JSON.stringify(data)}`);
  }

  const token = data.result.access_token;
  // Token Tuya berlaku 2 jam (7200s). Cache 1.5 jam (5400s) untuk aman.
  const expireAt = Date.now() + 5400 * 1000;
  await env.CACHE.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({ token, expireAt }),
    { expirationTtl: 5400 }
  );
  return token;
}

// Panggil endpoint bisnis Tuya (otomatis handle token + signing).
export async function tuyaRequest(env, method, path, body) {
  const accessToken = await getAccessToken(env);
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sign = await signBusinessRequest(
    env,
    accessToken,
    method,
    path,
    t,
    nonce,
    bodyStr
  );

  const res = await fetch(env.TUYA_BASE_URL + path, {
    method,
    headers: {
      client_id: env.TUYA_CLIENT_ID,
      access_token: accessToken,
      sign,
      t,
      sign_method: "HMAC-SHA256",
      nonce,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });
  return res.json();
}

// Ambil status banyak device sekaligus (hemat quota - 1 request untuk banyak device).
// Endpoint: GET /v1.0/iot-03/devices/status?device_ids=id1,id2
export async function getDevicesStatus(env, deviceIds) {
  const ids = deviceIds.filter(Boolean).join(",");
  if (!ids) return [];
  const data = await tuyaRequest(
    env,
    "GET",
    `/v1.0/iot-03/devices/status?device_ids=${ids}`,
    ""
  );
  if (!data.success) {
    throw new Error(`Tuya status error: ${data.msg || JSON.stringify(data)}`);
  }
  return data.result || [];
}

// Info detail satu device (nama, online, dsb).
export async function getDeviceInfo(env, deviceId) {
  const data = await tuyaRequest(env, "GET", `/v1.0/devices/${deviceId}`, "");
  if (!data.success) {
    throw new Error(`Tuya device error: ${data.msg || JSON.stringify(data)}`);
  }
  return data.result;
}

// Kirim perintah ke device (nyala/mati, dsb).
// commands: [{ code: "switch_1", value: true }]
export async function sendCommands(env, deviceId, commands) {
  const data = await tuyaRequest(
    env,
    "POST",
    `/v1.0/iot-03/devices/${deviceId}/commands`,
    { commands }
  );
  return data;
}
