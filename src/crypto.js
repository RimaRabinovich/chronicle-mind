/**
 * crypto.js — client-side encryption (WebCrypto only)
 *
 * A random 256-bit data key (DEK) encrypts every record with AES-GCM. The DEK is
 * stored only wrapped by a key derived from the user's passphrase
 * (PBKDF2-SHA256, 600k iterations). The recovery key is the DEK itself, shown once.
 *
 * Each ciphertext is bound to a label (e.g. "entries:<id>") as AES-GCM
 * additional data, so records can't be swapped between ids or stores.
 * After unlock the DEK is held as a non-extractable CryptoKey.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 600_000;
const AES_GCM = { name: 'AES-GCM', length: 256 };
const CHECK_LABEL = 'vault-check';
const CHECK_TEXT  = 'chronicle-mind-vault';

let dataKey = null;   // non-extractable CryptoKey while unlocked

export class WrongKeyError extends Error {}

export const isUnlocked = () => dataKey !== null;
export const getDataKey = () => dataKey;
export function setDataKey(key) { dataKey = key; }
export function lock() { dataKey = null; }

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

function requireKey() {
  if (!dataKey) throw new Error('Vault is locked');
  return dataKey;
}

// ── Passphrase wrapping ──────────────────────────────────

async function deriveKek(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, AES_GCM, false, ['wrapKey', 'unwrapKey'],
  );
}

/** Wrap an extractable DEK with a passphrase; returns the stored vault fields. */
async function wrapWithPassphrase(extractableDek, passphrase) {
  const salt = random(16);
  const iv = random(12);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapped = await crypto.subtle.wrapKey('raw', extractableDek, kek, { name: 'AES-GCM', iv });
  return { salt, iv, iterations: PBKDF2_ITERATIONS, wrapped };
}

const importDek = (raw, extractable) =>
  crypto.subtle.importKey('raw', raw, AES_GCM, extractable, ['encrypt', 'decrypt']);

/**
 * Create a new vault: a fresh DEK wrapped by the passphrase.
 * Unlocks it and returns { vault, recoveryKey }. `vault` is stored as-is.
 */
export async function createVault(passphrase) {
  const raw = random(32);
  const extractable = await importDek(raw, true);
  const wrap = await wrapWithPassphrase(extractable, passphrase);
  dataKey = await importDek(raw, false);
  const check = await encryptBytes(enc.encode(CHECK_TEXT), CHECK_LABEL);
  return { vault: { version: 1, ...wrap, check }, recoveryKey: encodeRecoveryKey(raw) };
}

/** Unlock with the passphrase; throws WrongKeyError if it doesn't match. */
export async function unlockWithPassphrase(vault, passphrase) {
  const kek = await deriveKek(passphrase, vault.salt, vault.iterations);
  try {
    dataKey = await crypto.subtle.unwrapKey(
      'raw', vault.wrapped, kek, { name: 'AES-GCM', iv: vault.iv },
      AES_GCM, false, ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongKeyError('Wrong passphrase');
  }
}

/**
 * Unlock with the recovery key and set a new passphrase.
 * Returns the updated vault record to store; throws WrongKeyError on a bad key.
 */
export async function recoverVault(vault, recoveryKey, newPassphrase) {
  let raw;
  try {
    raw = decodeRecoveryKey(recoveryKey);
  } catch {
    throw new WrongKeyError('That recovery key is not valid');
  }
  const candidate = await importDek(raw, false);
  try {
    const iv = vault.check.iv;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(CHECK_LABEL) }, candidate, vault.check.ct,
    );
    if (dec.decode(plain) !== CHECK_TEXT) throw new Error();
  } catch {
    throw new WrongKeyError('That recovery key does not match this vault');
  }
  const wrap = await wrapWithPassphrase(await importDek(raw, true), newPassphrase);
  dataKey = candidate;
  return { ...vault, ...wrap };
}

// ── Recovery key: the DEK as Crockford base32, in groups of 4 ──

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeRecoveryKey(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

function decodeRecoveryKey(text) {
  const clean = text.toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error('bad character');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length !== 32) throw new Error('bad length');
  return new Uint8Array(out);
}

// ── Record encryption ────────────────────────────────────

/** Encrypt bytes; `label` must be given again to decrypt. */
export async function encryptBytes(data, label) {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(label) }, requireKey(), data,
  );
  return { iv, ct };
}

export async function decryptBytes({ iv, ct }, label) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(label) }, requireKey(), ct,
  );
}

export async function encryptJSON(value, label) {
  return encryptBytes(enc.encode(JSON.stringify(value)), label);
}

export async function decryptJSON(sealed, label) {
  return JSON.parse(dec.decode(await decryptBytes(sealed, label)));
}
