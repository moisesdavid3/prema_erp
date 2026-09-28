const IV_LENGTH = 12;

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.EINVOICING_CREDENTIALS_KEY;
  if (!secret) {
    throw new Error("Falta la variable de entorno EINVOICING_CREDENTIALS_KEY.");
  }
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32) {
    throw new Error(
      "EINVOICING_CREDENTIALS_KEY debe ser una llave de 32 bytes en base64 (genérala con `openssl rand -base64 32`).",
    );
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredentials(credentials: Record<string, string>): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

export async function decryptCredentials(encrypted: string): Promise<Record<string, string>> {
  const key = await getKey();
  const combined = Buffer.from(encrypted, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
