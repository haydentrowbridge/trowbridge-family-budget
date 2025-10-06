/// <reference lib="dom" />
// src/lib/crypto.ts
// AES-GCM + PBKDF2 with passphrase-derived key (E2EE).
// Stored shape: { v:1, salt, iv, cipher } where each value is base64.

const g = globalThis as any;

/** Base64 encode/decode helpers that operate on Uint8Array */
function b64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return g.btoa(bin);
}
function b64DecodeToBytes(b64: string): Uint8Array {
  const bin = g.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, saltBytes: Uint8Array): Promise<CryptoKey> {
  const encText = new TextEncoder().encode(passphrase);
  const baseKey = await g.crypto.subtle.importKey("raw", encText, "PBKDF2", false, ["deriveKey"]);
  // TS-safe: keep params as any to avoid lib/DOM typing mismatches
  const params = { name: "PBKDF2", salt: saltBytes, iterations: 100_000, hash: "SHA-256" } as any;
  return g.crypto.subtle.deriveKey(
    params,
    baseKey,
    { name: "AES-GCM", length: 256 } as any,
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJSON(passphrase: string, obj: unknown): Promise<string> {
  // Generate salt & IV as fresh byte arrays
  const salt: Uint8Array = g.crypto.getRandomValues(new Uint8Array(16));
  const iv: Uint8Array   = g.crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(passphrase, salt);

  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  // TS-safe: cast params to any so iv is accepted in all environments
  const encParams = { name: "AES-GCM", iv } as any;
  const cipherBuf: ArrayBuffer = await g.crypto.subtle.encrypt(encParams, key, plaintext);

  // Convert outputs to base64 strings (store as JSON)
  return JSON.stringify({
    v: 1,
    salt: b64Encode(salt),
    iv: b64Encode(iv),
    cipher: b64Encode(new Uint8Array(cipherBuf)),
  });
}

export async function decryptJSON(passphrase: string, payload: string): Promise<any> {
  const parsed = JSON.parse(payload);
  if (!parsed || parsed.v !== 1) throw new Error("Unsupported payload");

  const saltBytes   = b64DecodeToBytes(parsed.salt);
  const ivBytes     = b64DecodeToBytes(parsed.iv);
  const cipherBytes = b64DecodeToBytes(parsed.cipher);

  const key = await deriveKey(passphrase, saltBytes);
  const decParams = { name: "AES-GCM", iv: ivBytes } as any;
  const plainBuf: ArrayBuffer = await g.crypto.subtle.decrypt(decParams, key, cipherBytes);
  const text = new TextDecoder().decode(plainBuf);
  return JSON.parse(text);
}
