/**
 * At-rest secret encryption utility (AES-256-GCM).
 *
 * Used by SqliteProviderStore to avoid storing provider API keys in plaintext
 * inside `config.db`. The encryption key is derived from a passphrase (via
 * scrypt) and sourced from the `YACHIYO_DB_KEY` environment variable, or from
 * an auto-generated key file when the env var is absent.
 *
 * Formats:
 * - v2 (current): `enc:v2:<saltB64>:<ivB64>:<tagB64>:<dataB64>`. A fresh
 *   random salt is embedded in every ciphertext and the AES key is derived
 *   per-secret via scrypt, so identical plaintexts never produce identical
 *   ciphertexts and precomputed-dictionary attacks against the master key
 *   are infeasible (#97).
 * - v1 (legacy, read-only): `enc:v1:<base64(iv)>:<base64(ciphertext+tag)>`
 *   with a fixed salt. Still decryptable for existing rows; no longer written.
 *
 * Backward compatibility: {@link decryptSecret} returns the input unchanged
 * when it does not carry an `enc:` prefix, so existing plaintext rows
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

const ENCRYPTED_PREFIX_V1 = "enc:v1:";
const ENCRYPTED_PREFIX_V2 = "enc:v2:";
/** Fixed salt for the legacy v1 format (kept so existing rows stay readable). */
const LEGACY_SCRYPT_SALT = "yachiyo-secret-crypto-v1";
const KEY_LENGTH = 32; // AES-256
/** Salt length for the v2 format (embedded in each ciphertext). */
const V2_SALT_LENGTH = 16;

/**
 * Derive the master key from a passphrase using scrypt.
 *
 * The salt is fixed so the same passphrase always yields the same master
 * key (required for key identification across restarts). Per-secret
 * randomization for the v2 format happens inside {@link encryptSecret},
 * which re-derives an AES key from this master key with a fresh random salt.
 */
export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, LEGACY_SCRYPT_SALT, KEY_LENGTH);
}

/**
 * Encrypt a plaintext secret (v2 format).
 * Returns `enc:v2:<saltB64>:<ivB64>:<tagB64>:<dataB64>` where `salt` is a
 * fresh random salt used to derive the per-secret AES key from the master
 * key. Returns the empty string unchanged.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (plaintext === "") return "";
  const salt = randomBytes(V2_SALT_LENGTH);
  const derivedKey = scryptSync(key, salt, KEY_LENGTH);
  const iv = randomBytes(12); // 96-bit IV (GCM standard)
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Prefix already ends with ":"; the four fields are joined with ":".
  return ENCRYPTED_PREFIX_V2 + [
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a secret produced by {@link encryptSecret} (v2) or by the legacy
 * v1 format.
 *
 * - Input without an `enc:` prefix is returned as-is (legacy plaintext rows).
 * - Malformed input or a failed decryption (wrong key, corrupted ciphertext,
 *   tampered tag) is logged with context and returns `null` so callers can
 *   degrade gracefully instead of receiving garbage that looks like a secret.
 */
export function decryptSecret(stored: string, key: Buffer): string | null {
  if (!stored) return stored;

  if (stored.startsWith(ENCRYPTED_PREFIX_V2)) {
    const parts = stored.slice(ENCRYPTED_PREFIX_V2.length).split(":");
    if (parts.length !== 4) {
      console.error("[secret-crypto] Malformed v2 ciphertext (expected 4 fields, " +
        `got ${parts.length}); refusing to return garbage.`);
      return null;
    }
    try {
      const salt = Buffer.from(parts[0], "base64");
      const iv = Buffer.from(parts[1], "base64");
      const tag = Buffer.from(parts[2], "base64");
      const ciphertext = Buffer.from(parts[3], "base64");
      const derivedKey = scryptSync(key, salt, KEY_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    } catch (e) {
      console.error("[secret-crypto] Failed to decrypt v2 ciphertext " +
        "(wrong key or corrupted/tampered data):", e);
      return null;
    }
  }

  if (stored.startsWith(ENCRYPTED_PREFIX_V1)) {
    // Legacy v1: fixed salt, master key used directly as the AES key,
    // tag appended to the ciphertext. Kept read-only for existing rows.
    const rest = stored.slice(ENCRYPTED_PREFIX_V1.length);
    const sepIndex = rest.indexOf(":");
    if (sepIndex === -1) {
      console.error("[secret-crypto] Malformed v1 ciphertext (missing iv separator); " +
        "refusing to return garbage.");
      return null;
    }
    try {
      const iv = Buffer.from(rest.slice(0, sepIndex), "base64");
      const payload = Buffer.from(rest.slice(sepIndex + 1), "base64");
      if (payload.length < 16) {
        console.error("[secret-crypto] Malformed v1 ciphertext (payload too short); " +
          "refusing to return garbage.");
        return null;
      }
      const ciphertext = payload.subarray(0, -16);
      const tag = payload.subarray(-16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    } catch (e) {
      console.error("[secret-crypto] Failed to decrypt v1 ciphertext " +
        "(wrong key or corrupted/tampered data):", e);
      return null;
    }
  }

  if (stored.startsWith("enc:")) {
    console.error("[secret-crypto] Unknown ciphertext version prefix " +
      `"${stored.slice(0, stored.indexOf(":") + 1)}"; refusing to return garbage.`);
    return null;
  }

  return stored; // plaintext (legacy) or empty
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
