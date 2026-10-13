/**
 * store/vault.js — create, unlock and lock the local encrypted vault
 *
 * The vault record (wrapped data key + salt) lives in the `meta` store.
 * "Remember on this device" stores the non-extractable data key itself in
 * IndexedDB, so this browser profile can open the vault without the passphrase
 * (the key can be used but never read out).
 */

import { getDB } from './db.js';
import * as vaultCrypto from '../crypto.js';

const VAULT_KEY  = 'vault';
const DEVICE_KEY = 'device-key';

export { WrongKeyError, isUnlocked } from '../crypto.js';

export async function hasVault() {
  return (await (await getDB()).get('meta', VAULT_KEY)) !== undefined;
}

async function rememberDevice(remember) {
  const db = await getDB();
  if (remember) await db.put('meta', vaultCrypto.getDataKey(), DEVICE_KEY);
  else await db.delete('meta', DEVICE_KEY);
}

/** Ask the browser not to evict our data under storage pressure. */
function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

/** Create the vault; returns the recovery key to show the user once. */
export async function createVault(passphrase, { remember = false } = {}) {
  const { vault, recoveryKey } = await vaultCrypto.createVault(passphrase);
  await (await getDB()).put('meta', vault, VAULT_KEY);
  await rememberDevice(remember);
  requestPersistence();
  return recoveryKey;
}

export async function unlock(passphrase, { remember = false } = {}) {
  const vault = await (await getDB()).get('meta', VAULT_KEY);
  await vaultCrypto.unlockWithPassphrase(vault, passphrase);
  await rememberDevice(remember);
  requestPersistence();
}

/** Unlock with the recovery key and replace the passphrase. */
export async function recover(recoveryKey, newPassphrase, { remember = false } = {}) {
  const db = await getDB();
  const updated = await vaultCrypto.recoverVault(await db.get('meta', VAULT_KEY), recoveryKey, newPassphrase);
  await db.put('meta', updated, VAULT_KEY);
  await rememberDevice(remember);
}

/** Unlock with the key remembered on this device, if any. Returns true on success. */
export async function tryDeviceUnlock() {
  const key = await (await getDB()).get('meta', DEVICE_KEY);
  if (!key) return false;
  vaultCrypto.setDataKey(key);
  return true;
}

/** Lock the vault. With `forget`, this device no longer opens it without the passphrase. */
export async function lockVault({ forget = false } = {}) {
  vaultCrypto.lock();
  if (forget) await (await getDB()).delete('meta', DEVICE_KEY).catch(() => {});
}
