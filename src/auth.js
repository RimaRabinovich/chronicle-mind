// src/auth.js — Firebase Google Auth helper
//
// Reads config from Vite env vars (all prefixed VITE_FIREBASE_*)
// Exports: initAuth, signInWithGoogle, signOutUser, onAuthChange, currentUser

import { initializeApp }                          from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey:     import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:  import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

let app  = null;
let auth = null;

export function initAuth() {
  if (app) return; // already initialised
  app  = initializeApp(firebaseConfig);
  auth = getAuth(app);
}

/** Returns the current user object (or null) */
export function currentUser() {
  return auth?.currentUser ?? null;
}

/** Open Google sign-in popup. Returns the signed-in User or throws. */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result   = await signInWithPopup(auth, provider);
  return result.user;
}

/** Sign the current user out. */
export async function signOutUser() {
  await signOut(auth);
}

/** Subscribe to auth state changes. Callback receives (user | null). */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}
