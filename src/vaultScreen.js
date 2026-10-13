/**
 * vaultScreen.js — the create / unlock / recover screen shown after sign-in
 *
 * openVault() resolves once the vault is unlocked (immediately if this device
 * remembers the key). First run: choose a passphrase, then save the recovery key.
 */

import { hasVault, createVault, unlock, recover, tryDeviceUnlock, WrongKeyError } from './store/vault.js';

const $ = (id) => document.getElementById(id);
const MIN_PASSPHRASE = 8;
const FORMS = ['vault-create', 'vault-recovery', 'vault-unlock', 'vault-recover'];

let resolveUnlocked = null;
let wired = false;

function show(formId, title, subtitle = '') {
  for (const id of FORMS) $(id).classList.toggle('hidden', id !== formId);
  $('vault-title').textContent = title;
  $('vault-subtitle').textContent = subtitle;
  hideError();
  $(formId).querySelector('input')?.focus();
}

function showError(msg) {
  $('vault-error').textContent = msg;
  $('vault-error').classList.remove('hidden');
}
function hideError() { $('vault-error').classList.add('hidden'); }

/** Validate a new passphrase pair; returns an error message or null. */
function checkNewPassphrase(a, b) {
  if (a.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (a !== b) return "The passphrases don't match.";
  return null;
}

/** Disable a form's buttons while `fn` runs (key derivation takes a moment). */
async function busy(form, label, fn) {
  const submit = form.querySelector('button[type="submit"]');
  const original = submit.textContent;
  form.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
  submit.textContent = label;
  try {
    await fn();
  } finally {
    form.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
    submit.textContent = original;
  }
}

function done() {
  $('vault-screen').classList.add('hidden');
  for (const id of ['vault-new-pass', 'vault-new-pass2', 'vault-pass', 'vault-recovery-input', 'vault-reset-pass', 'vault-reset-pass2']) {
    $(id).value = '';
  }
  $('vault-recovery-key').textContent = '';
  resolveUnlocked?.();
  resolveUnlocked = null;
}

function wire(onSignOut) {
  if (wired) return;
  wired = true;

  $('vault-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('vault-new-pass').value;
    const problem = checkNewPassphrase(pass, $('vault-new-pass2').value);
    if (problem) return showError(problem);
    await busy(e.target, 'Creating…', async () => {
      const recoveryKey = await createVault(pass, { remember: $('vault-create-remember').checked });
      $('vault-recovery-key').textContent = recoveryKey;
      $('vault-saved-check').checked = false;
      $('vault-recovery-done').disabled = true;
      show('vault-recovery', 'Save your recovery key');
    }).catch(err => showError(`Could not create the vault: ${err.message}`));
  });

  $('vault-copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('vault-recovery-key').textContent);
      $('vault-copy-key').textContent = 'Copied';
    } catch {
      showError('Copy failed; select the key and copy it manually.');
    }
  });
  $('vault-download-key').addEventListener('click', () => {
    const text = `Chronicle Mind recovery key\n\n${$('vault-recovery-key').textContent}\n\n` +
      'Use it with "Forgot your passphrase?" if you lose your passphrase.\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'chronicle-mind-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('vault-saved-check').addEventListener('change', (e) => {
    $('vault-recovery-done').disabled = !e.target.checked;
  });
  $('vault-recovery-done').addEventListener('click', done);

  $('vault-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(e.target, 'Unlocking…', async () => {
      await unlock($('vault-pass').value, { remember: $('vault-unlock-remember').checked });
      done();
    }).catch(err => {
      showError(err instanceof WrongKeyError ? 'Wrong passphrase. Try again.' : `Could not unlock: ${err.message}`);
      $('vault-pass').select();
    });
  });

  $('vault-recover').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('vault-reset-pass').value;
    const problem = checkNewPassphrase(pass, $('vault-reset-pass2').value);
    if (problem) return showError(problem);
    await busy(e.target, 'Unlocking…', async () => {
      await recover($('vault-recovery-input').value, pass, { remember: $('vault-recover-remember').checked });
      done();
    }).catch(err => showError(err instanceof WrongKeyError ? err.message : `Could not unlock: ${err.message}`));
  });

  $('vault-show-recover').addEventListener('click', () =>
    show('vault-recover', 'Use your recovery key', 'Then choose a new passphrase.'));
  $('vault-show-unlock').addEventListener('click', () =>
    show('vault-unlock', 'Unlock your memories'));
  $('vault-signout').addEventListener('click', onSignOut);
}

/**
 * Show the vault screen until the vault is unlocked.
 * @param {() => void} onSignOut  called by the screen's "Sign out" link
 */
export async function openVault(onSignOut) {
  wire(onSignOut);
  if (await tryDeviceUnlock()) return;

  $('vault-screen').classList.remove('hidden');
  if (await hasVault()) {
    show('vault-unlock', 'Unlock your memories');
  } else {
    show('vault-create', 'Protect your memories', 'One-time setup on this device.');
  }
  return new Promise(resolve => { resolveUnlocked = resolve; });
}

/** Hide the vault screen (e.g. on sign-out while it's open). */
export function closeVault() {
  $('vault-screen').classList.add('hidden');
  resolveUnlocked = null;
}
