/**
 * Verify a Firebase ID token and return the decoded UID.
 * Uses Google's public JWKS to validate the RS256 signature.
 */

const JWKS_URI =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

interface JWK {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg: string;
  use: string;
}

interface JWKSResponse {
  keys: JWK[];
}

// Cache public keys for the duration of the function execution
let cachedKeys: Record<string, CryptoKey> = {};

async function getPublicKeys(): Promise<Record<string, CryptoKey>> {
  const res = await fetch(JWKS_URI);
  const jwks: JWKSResponse = await res.json();
  const keys: Record<string, CryptoKey> = {};

  for (const jwk of jwks.keys) {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys[jwk.kid] = cryptoKey;
  }

  cachedKeys = keys;
  return keys;
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

export interface FirebaseClaims {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Verify a Firebase JWT from the Authorization header.
 * Returns the decoded claims or throws if invalid.
 */
export async function verifyFirebaseToken(
  authHeader: string | null,
  projectId: string,
): Promise<FirebaseClaims> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header');
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');

  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const signatureB64 = parts[2];

  // Decode header to get kid
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
  if (header.alg !== 'RS256') throw new Error('Unsupported algorithm');

  // Decode payload
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));

  // Validate claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired');
  if (payload.iat > now + 300) throw new Error('Token issued in the future');
  if (payload.aud !== projectId) throw new Error('Token audience mismatch');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw new Error('Token issuer mismatch');

  // Get public keys (use cache if populated)
  const keys = Object.keys(cachedKeys).length ? cachedKeys : await getPublicKeys();
  const publicKey = keys[header.kid];
  if (!publicKey) throw new Error('Unknown key ID');

  // Verify signature
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(signatureB64);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    signingInput,
  );

  if (!valid) throw new Error('Invalid token signature');

  return {
    uid: payload.sub || payload.user_id,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
