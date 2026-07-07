/**
 * src/services/googleDrive.js
 *
 * REST client for Google Drive API.
 * Uses transient OAuth 2.0 access tokens retrieved via Firebase.
 */

/**
 * List text, audio, and video files from the user's Google Drive.
 * @param {string} accessToken - Google OAuth token
 * @param {string} search      - optional name search filter
 * @returns {Promise<Array>}
 */
export async function listDriveFiles(accessToken, search = '') {
  const qParts = [
    "mimeType = 'text/plain'",
    "mimeType = 'text/markdown'",
    "mimeType = 'audio/mpeg'",
    "mimeType = 'audio/wav'",
    "mimeType = 'audio/mp3'",
    "mimeType = 'audio/mp4'",
    "mimeType = 'audio/x-m4a'",
    "mimeType = 'audio/webm'",
    "mimeType = 'video/mp4'",
    "mimeType = 'video/webm'"
  ];
  let q = `(${qParts.join(' or ')})`;

  if (search.trim()) {
    const escaped = search.replace(/'/g, "\\'");
    q = `${q} and name contains '${escaped}'`;
  }

  q = `${q} and trashed = false`;

  const url = `https://www.googleapis.com/drive/v3/files?pageSize=50&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,size)&orderBy=modifiedTime desc`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Google Drive list failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.files || [];
}

/**
 * Fetch raw text content of a Drive file.
 */
export async function downloadDriveFileText(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Download text failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch binary data blob of a Drive file (audio/video).
 */
export async function downloadDriveFileBlob(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Download file blob failed: HTTP ${res.status}`);
  return res.blob();
}
