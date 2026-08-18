/**
 * Web Crypto AES-GCM encryption/decryption for credentials in Cloudflare Workers.
 */

async function getKey(secret) {
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest("SHA-256", enc.encode(secret || "dspace-edge-default-secret"));
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPassword(plainText, secret) {
  if (!plainText) return "";
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainText)
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptPassword(cipherBase64, secret) {
  if (!cipherBase64) return "";
  try {
    const key = await getKey(secret);
    const combinedStr = atob(cipherBase64);
    const combined = new Uint8Array(combinedStr.length);
    for (let i = 0; i < combinedStr.length; i++) {
      combined[i] = combinedStr.charCodeAt(i);
    }
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error("Decryption failed:", err);
    return cipherBase64;
  }
}
