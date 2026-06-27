/**
 * At-rest secret encryption utility (AES-256-GCM).
 *
 * Used by SqliteProviderStore to avoid storing provider API keys in plaintext
 * inside `config.db`. The encryption key is derived from a passphrase (via
 * scrypt) and sourced from the `YACHIYO_DB_KEY` environment variable, or from
 * an auto-generated key file when the env var is absent.
 *
 * Backward compatibility: {@link decryptSecret} returns the input unchanged
 * when it does not carry the `enc:v1:` prefix, so existing plaintext rows
 * continue to work after enabling encryption.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const ENCRYPTED_PREFIX = "enc:v1:";
const SCRYPT_SALT = "yachiyo-secret-crypto-v1";
const KEY_LENGTH = 32; // AES-256

/**
 * Derive a 32-byte AES key from a passphrase using scrypt.
 * The salt is fixed so the same passphrase always yields the same key
 * (allowing key rotation by changing the passphrase).
 */
export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SCRYPT_SALT, KEY_LENGTH);
}

/**
 * Encrypt a plaintext secret.
 * Returns a string of the form `enc:v1:<base64(iv)>:<base64(ciphertext+tag)>`.
 * Returns the empty string unchanged.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (plaintext === "") return "";
  const iv = randomBytes(12); // 96-bit IV (GCM standard)
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack ciphertext + tag together (tag appended at the end, 16 bytes)
  const payload = Buffer.concat([encrypted, tag]);
  return `${ENCRYPTED_PREFIX}${iv.toString("base64")}:${payload.toString("base64")}`;
}

/**
 * Decrypt a secret produced by {@link encryptSecret}.
 * If the input does not carry the `enc:v1:` prefix it is returned as-is
 * (backward compatibility with pre-encryption plaintext rows).
 */
export function decryptSecret(stored: string, key: Buffer): string {
  if (!stored || !stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored; // plaintext (legacy) or empty
  }
  const rest = stored.slice(ENCRYPTED_PREFIX.length);
  const sepIndex = rest.indexOf(":");
  if (sepIndex === -1) return stored; // malformed — return as-is rather than crash
  const iv = Buffer.from(rest.slice(0, sepIndex), "base64");
  const payload = Buffer.from(rest.slice(sepIndex + 1), "base64");
  if (payload.length < 16) return stored; // malformed
  const ciphertext = payload.subarray(0, -16);
  const tag = payload.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export interface EncryptionKeyOptions {
  /** Environment variable name to read the passphrase from. */
  envVar?: string;
  /** Fallback key-file path. When the env var is absent the key is read from (or written to) this file. */
  keyFilePath?: string;
}

/**
 * Resolve the encryption key.
 *
 * Priority:
 * 1. `process.env[envVar]` — operator-provided passphrase (recommended for production).
 * 2. `keyFilePath` — auto-generated 32-byte key persisted to disk (better than plaintext; suitable for dev).
 *
 * Returns `undefined` when neither source is available, in which case the
 * caller should skip encryption (keeping existing plaintext behavior).
 */
export function loadEncryptionKey(options: EncryptionKeyOptions = {}): Buffer | undefined {
  const { envVar = "YACHIYO_DB_KEY", keyFilePath } = options;

  const envPass = process.env[envVar];
  if (envPass && envPass.length > 0) {
    return deriveKey(envPass);
  }

  if (keyFilePath) {
    if (existsSync(keyFilePath)) {
      const raw = readFileSync(keyFilePath);
      // The file may contain either a 32-byte raw key or a hex/base64 string.
      if (raw.length === KEY_LENGTH) return Buffer.from(raw);
      const str = raw.toString("utf8").trim();
      if (str.length === KEY_LENGTH * 2 && /^[0-9a-f]+$/i.test(str)) {
        return Buffer.from(str, "hex");
      }
      // Treat as passphrase
      return deriveKey(str);
    }
    // Auto-generate a random key file
    try {
      const dir = dirname(keyFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const newKey = randomBytes(KEY_LENGTH);
      writeFileSync(keyFilePath, newKey, { mode: 0o600 });
      console.log(`[secret-crypto] Generated new encryption key file at ${keyFilePath}`);
      return newKey;
    } catch {
      // If we can't write the key file, fall through to undefined
    }
  }

  return undefined;
}
