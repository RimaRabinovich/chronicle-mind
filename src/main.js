/**
 * main.js — Chronicle Mind App Orchestrator
 *
 * Responsibilities:
 *  - Boot: auth gate → load memories from Supabase → render timeline
 *  - Capture: text textarea + audio recorder → Groq Whisper transcription
 *  - Embed: server-side via Supabase Edge Function (fire-and-forget)
 *  - Save: persist memory to Supabase cloud DB
 *  - Related: cosine similarity via pgvector in Supabase
 *  - Timeline: chronological render, day-grouped, expandable cards
 */

import './style.css';

// ── Cloud service layer (replaces local IndexedDB db.js) ──────────────
import { saveMemory, getAllMemories, deleteMemory, updateMemory, deleteAllUserMemories } from './services/memories.js';
import { saveEvent, updateEvent, deleteEvent, getAllEvents, deleteEventsByMemoryId, deleteAllUserEvents } from './services/events.js';
import { triggerEmbedding } from './services/rag.js';
import { uploadFile, deleteUserFolder } from './services/storage.js';


// ── Other utilities ───────────────────────────────────────────────────
import { transcribeAudio }           from './transcription.js';
import { AudioRecorder }             from './recorder.js';

import { summarizeContent, extractEvents } from './ai.js';
import { initAuth, signInWithGoogle, signOutUser, onAuthChange, reauthenticateUser, getDriveAccessToken } from './auth.js';
import { listDriveFiles, downloadDriveFileText, downloadDriveFileBlob } from './services/googleDrive.js';



// ── DOM helpers ────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── App State ──────────────────────────────────────────
let entries       = [];          // all stored memories (chronological, newest first)
let currentMode   = 'text';      // 'text' | 'audio'
let currentTranscript = '';      // transcript from last recording
let audioBlob     = null;        // raw Blob from MediaRecorder
let recorder      = null;        // AudioRecorder instance
let recTimerID    = null;        // setInterval handle for timer
let recSeconds    = 0;           // elapsed recording seconds
const audioURLs   = new Map();   // entry.id → ObjectURL (lazy)
const eventsCache = new Map();   // event.id → event object (for edit handler)
let   eventsCount = 0;           // kept in sync by renderEventsTimeline

let   pendingEvents   = [];      // holds extracted events before user approval
let   appInitialized  = false;   // prevents duplicate init() on auth re-fires

// File Import state
let importFile         = null;        // File object (local) or metadata object (Drive)
let importSource       = '';          // 'local' | 'drive'
let importDriveToken   = '';          // transient Google Drive access token
let importDriveFiles   = [];          // list of matching Drive files
let importRegistered   = false;       // registration guard for import panel listeners


// Prevent duplicate event listener attachments on sign-out/sign-in cycles
let entryInteractionsRegistered = false;
let eventInteractionsRegistered = false;
let pendingEventsRegistered     = false;
let viewTabsRegistered          = false;
let tabsRegistered              = false;
let recorderRegistered          = false;
let submitRegistered            = false;


// ── Boot ───────────────────────────────────────────────
/** Called once after a user is confirmed signed-in */
async function init() {
  try {
    await loadMemories();
    renderTimeline();
    setupViewTabs();
    setupTabs();
    setupRecorder();
    setupImport();
    setupSubmit();
    setupEntryInteractions();
    setupEventsInteractions();
    setupAddEventBtn();
    setupPendingEvents();
  } catch (err) {
    console.error('App initialization failed', err);
    showToast(
      err?.message || 'Could not load your memories right now. Please try signing out and back in.',
      'error'
    );
  }
}


/** Boot the auth layer then gate on sign-in */
function bootAuth() {
  initAuth();

  // Sign-in button on the login screen
  $('login-google-btn').addEventListener('click', async () => {
    $('login-google-btn').disabled = true;
    $('login-google-btn').textContent = 'Signing in…';
    hideLoginError();
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Google sign-in failed', err);
      showLoginError(err.code === 'auth/popup-closed-by-user'
        ? 'Sign-in was cancelled. Please try again.'
        : `Sign-in error: ${err.message}`);
      $('login-google-btn').disabled = false;
      $('login-google-btn').innerHTML = googleBtnHTML();
    }
  });

  // Dropdown toggle
  $('user-profile-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    $('user-dropdown').classList.toggle('hidden');
  });

  // Close dropdown on click outside
  document.addEventListener('click', () => {
    const dropdown = $('user-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
  });

  // Sign-out button inside the dropdown
  $('signout-btn').addEventListener('click', async () => {
    await signOutUser();
    // Reset in-memory state so re-login starts fresh
    entries = [];
    eventsCount = 0;
    pendingEvents = [];
    eventsCache.clear();
    audioURLs.clear();
  });

  // Delete account button inside the dropdown
  $('delete-account-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    $('user-dropdown').classList.add('hidden');

    const { currentUser: getFbUser } = await import('./auth.js');
    const user = getFbUser();
    if (!user) {
      showToast('No active user session found.', 'error');
      return;
    }
    const uid = user.uid;

    const confirmed = confirm(
      "Are you sure you want to permanently delete all your account data?\n\n" +
      "This will erase all your memories, audio files, and life events forever.\n" +
      "This action CANNOT be undone."
    );
    if (!confirmed) return;

    const doubleConfirmed = prompt("Type 'DELETE' to confirm deletion:");
    if (doubleConfirmed !== 'DELETE') {
      showToast('Account deletion cancelled.', 'info');
      return;
    }

    try {
      showToast('Deleting all data and files...', 'info');

      // 1. Delete all memories from Supabase (deletes memory rows and chunks)
      await deleteAllUserMemories();

      // 2. Delete all life events from Supabase (including manually created events)
      await deleteAllUserEvents();

      // 3. Delete all audio files from private Supabase Storage
      await deleteUserFolder(uid);

      // 4. Force Sign out user
      await signOutUser();

      showToast('Account data deleted successfully.', 'success');
    } catch (err) {
      console.error('Account data deletion failed:', err);
      showToast(`Deletion failed: ${err.message}`, 'error');
    }
  });




  // Auth state subscriber — single source of truth
  onAuthChange(async (user) => {
    if (user) {
      // User is signed in
      showApp(user);
      if (!appInitialized) {
        appInitialized = true;
        await init();
      }
    } else {
      // User signed out — reset flag so re-login re-initialises cleanly
      appInitialized = false;
      showLogin();
    }
  });
}


function showLoginError(msg) {
  const el = $('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLoginError() {
  const el = $('login-error');
  if (el) el.classList.add('hidden');
}

function showApp(user) {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  // Update avatar/name in header
  const avatar = $('user-avatar');
  const name   = $('user-name');
  if (avatar) {
    if (user.photoURL) {
      avatar.style.backgroundImage = `url('${user.photoURL}')`;
      avatar.textContent = '';
    } else {
      avatar.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
    }
  }
  if (name) name.textContent = user.displayName || user.email || '';
}

function showLogin() {
  $('login-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  // Reset login button
  const btn = $('login-google-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = googleBtnHTML(); }
}

function googleBtnHTML() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.9C34.5 33.5 30 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 6 1.1 8.1 3l6.2-6.2C34.9 5.2 29.8 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.8 0 20-7.8 20-19.4 0-1.3-.2-2.7-.5-4z"/><path fill="#34A853" d="M6.3 14.7l7 5.1C15 17 19.2 14 24 14c3.1 0 6 1.1 8.1 3l6.2-6.2C34.9 5.2 29.8 3 24 3 16.4 3 9.9 7.9 6.3 14.7z"/><path fill="#FBBC04" d="M24 45c5.8 0 10.9-2 14.6-5.3l-6.8-5.5C29.9 35.9 27.1 37 24 37c-5.9 0-10.9-4-12.6-9.4l-6.9 5.3C8.1 40.1 15.5 45 24 45z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.9c-.9 2.6-2.7 4.8-5.1 6.2l6.8 5.5C41.4 36.8 45 31 45 24c0-1.3-.2-2.7-.5-4z"/></svg>
  Continue with Google`;
}

// ── Data ───────────────────────────────────────────────
async function loadMemories() {
  // Memories come newest-first from the API; reverse for timeline render
  const cloud = await getAllMemories({ limit: 500 });
  // Map cloud schema to legacy shape for timeline rendering compatibility
  entries = cloud.map(m => ({
    id:           m.id,
    timestamp:    m.created_at,
    type:         m.type,
    content:      m.content,
    summary:      m.summary ?? null,
    audioData:    m.file_url ?? null,    // audio played via URL, not DataURL
    audioMimeType:m.file_type ?? null,
    duration:     m.duration_sec ?? null,
    metadata:     m.metadata ?? {},
    embedding:    [],                    // embeddings live in Supabase, not in-memory
  })).reverse();                         // oldest → newest for timeline
  updateCountBadge();
}

// Legacy migration helper removed (no longer offered)


/** Returns the Groq API key from .env only */
function getGroqKey() {
  return import.meta.env.VITE_GROQ_API_KEY?.trim() || '';
}



// ── View Tabs (Memories / Life Events) ─────────────────
function setupViewTabs() {
  if (viewTabsRegistered) return;
  viewTabsRegistered = true;

  $('vtab-memories').addEventListener('click', () => switchView('memories'));

  $('vtab-events').addEventListener('click',   async () => {
    switchView('events');
    await renderEventsTimeline();
  });
}

function switchView(view) {
  const isMemories = view === 'memories';
  $('vtab-memories').classList.toggle('active', isMemories);
  $('vtab-events').classList.toggle('active', !isMemories);
  $('vtab-memories').setAttribute('aria-selected', String(isMemories));
  $('vtab-events').setAttribute('aria-selected', String(!isMemories));
  $('view-memories').classList.toggle('active', isMemories);
  $('view-memories').classList.toggle('hidden', !isMemories);
  $('view-events').classList.toggle('active', !isMemories);
  $('view-events').classList.toggle('hidden', isMemories);
  updateCountBadge();
}

// ── Tabs ───────────────────────────────────────────────

function setupTabs() {
  if (tabsRegistered) return;
  tabsRegistered = true;

  $('tab-text').addEventListener('click',  () => switchTab('text'));
  $('tab-audio').addEventListener('click', () => switchTab('audio'));
  $('tab-import').addEventListener('click', () => switchTab('import'));

  // Character counter
  $('thought-input').addEventListener('input', () => {
    const len = $('thought-input').value.length;
    $('char-count').textContent = `${len.toLocaleString()} character${len !== 1 ? 's' : ''}`;
    refreshSubmitBtn();
  });

  // Keyboard shortcut Ctrl/Cmd+Enter
  $('thought-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSubmit();
  });
}

function switchTab(mode) {
  currentMode = mode;
  const isText   = mode === 'text';
  const isAudio  = mode === 'audio';
  const isImport = mode === 'import';

  $('tab-text').classList.toggle('active', isText);
  $('tab-audio').classList.toggle('active', isAudio);
  $('tab-import').classList.toggle('active', isImport);
  
  $('tab-text').setAttribute('aria-selected', String(isText));
  $('tab-audio').setAttribute('aria-selected', String(isAudio));
  $('tab-import').setAttribute('aria-selected', String(isImport));

  $('panel-text').classList.toggle('active', isText);
  $('panel-text').style.display = isText ? 'block' : 'none';
  
  $('panel-audio').classList.toggle('active', isAudio);
  $('panel-audio').style.display = isAudio ? 'block' : 'none';
  
  $('panel-import').classList.toggle('active', isImport);
  $('panel-import').style.display = isImport ? 'block' : 'none';

  refreshSubmitBtn();
}


// ── Recorder ───────────────────────────────────────────
function setupRecorder() {
  if (recorderRegistered) return;
  recorderRegistered = true;

  $('record-btn').addEventListener('click', toggleRecording);


  // Edit transcript
  $('edit-transcript').addEventListener('click', () => {
    const el = $('transcript-text');
    const isEditing = el.contentEditable === 'true';
    el.contentEditable = isEditing ? 'false' : 'true';
    $('edit-transcript').textContent = isEditing ? 'Edit' : 'Done';
    if (!isEditing) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      currentTranscript = el.textContent.trim();
      refreshSubmitBtn();
    }
  });

  $('transcript-text').addEventListener('input', refreshSubmitBtn);


  // Discard recording
  $('discard-recording').addEventListener('click', () => {
    currentTranscript = '';
    audioBlob = null;
    $('transcript-preview').classList.add('hidden');
    $('transcript-text').textContent = '';
    $('transcript-text').contentEditable = 'false';
    $('edit-transcript').textContent = 'Edit';
    $('recording-timer').textContent = '0:00';
    refreshSubmitBtn();
    showToast('Recording discarded.', 'info');
  });
}

async function toggleRecording() {
  if (!recorder) recorder = new AudioRecorder($('waveform-canvas'));
  if (!recorder.isRecording) await startRecording();
  else                       await stopRecording();
}

async function startRecording() {
  try {
    await recorder.start();

    $('record-btn').classList.add('recording');
    $('record-btn').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none" class="lucide lucide-square"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
    $('record-subtext').textContent = 'Recording… tap to stop and transcribe';
    $('waveform-canvas').style.display = 'block';

    recSeconds = 0;
    updateTimer();
    recTimerID = setInterval(() => { recSeconds++; updateTimer(); }, 1000);

    // Reset previous result
    currentTranscript = '';
    audioBlob = null;
    $('transcript-preview').classList.add('hidden');
    $('transcribing-indicator').classList.add('hidden');
    refreshSubmitBtn();
  } catch (err) {
    showToast('Could not access microphone. Check browser permissions.', 'error');
  }
}

async function stopRecording() {
  clearInterval(recTimerID);
  recSeconds = 0;
  updateTimer();
  $('record-btn').classList.remove('recording');
  $('record-btn').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  $('record-subtext').textContent = 'Tap to start a voice memory';
  $('waveform-canvas').style.display = 'none';

  audioBlob = await recorder.stop();

  const key = getGroqKey();
  if (!key) {
    showToast('Add a Groq API key in ⚙️ Settings to transcribe audio.', 'error');
    $('transcript-preview').classList.remove('hidden');
    $('transcript-text').textContent = '[No API key — use the Type tab for text input]';
    return;
  }

  $('transcribing-indicator').classList.remove('hidden');
  try {
    const text = await transcribeAudio(audioBlob, key);
    currentTranscript = text;
    $('transcript-text').textContent = text;
    $('transcript-preview').classList.remove('hidden');
    refreshSubmitBtn();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $('transcribing-indicator').classList.add('hidden');
  }
}

function updateTimer() {


  const m = Math.floor(recSeconds / 60);
  const s = recSeconds % 60;
  $('recording-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ── File Import Actions ────────────────────────────────

function setupImport() {
  if (importRegistered) return;
  importRegistered = true;

  // Trigger local file selection
  $('import-local-btn').addEventListener('click', () => {
    $('local-file-selector').click();
  });

  // Handle local file selection
  $('local-file-selector').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    importFile = file;
    importSource = 'local';

    // Show preview card
    $('import-filename').textContent = file.name;
    $('import-filesource').textContent = 'Local File';
    $('import-filesize').textContent = formatBytes(file.size);
    $('import-preview').classList.remove('hidden');

    refreshSubmitBtn();
  });

  // Discard selected file
  $('discard-import').addEventListener('click', () => {
    discardSelectedImport();
  });
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function discardSelectedImport() {
  importFile = null;
  importSource = '';
  $('local-file-selector').value = '';
  $('import-preview').classList.add('hidden');
  refreshSubmitBtn();
}



// ── Submit ─────────────────────────────────────────────
function setupSubmit() {
  if (submitRegistered) return;
  submitRegistered = true;


  $('submit-btn').addEventListener('click', handleSubmit);

}

function refreshSubmitBtn() {
  const hasText   = currentMode === 'text'   && $('thought-input').value.trim().length > 0;
  const hasAudio  = currentMode === 'audio'  && $('transcript-text').textContent.trim().length > 0;
  const hasImport = currentMode === 'import' && importFile !== null;
  $('submit-btn').disabled = !hasText && !hasAudio && !hasImport;
}

async function handleSubmit() {
  // ── Loading state ──
  const btn   = $('submit-btn');
  const label = $('submit-label');
  btn.disabled  = true;
  label.textContent = 'Saving…';

  if (currentMode === 'import') {
    const apiKey = getGroqKey();
    if (!apiKey) {
      showToast('Add a Groq API key in ⚙️ Settings to process imported files.', 'error');
      btn.disabled = false;
      label.textContent = 'Save memory';
      return;
    }

    const pIndicator = $('import-processing-indicator');
    const pText = $('import-processing-text');
    pIndicator.classList.remove('hidden');

    try {
      let content = '';
      const isText = importFile.mimeType ? 
        (importFile.mimeType.startsWith('text/') || importFile.name.endsWith('.txt') || importFile.name.endsWith('.md')) :
        (importFile.type.startsWith('text/') || importFile.name.endsWith('.txt') || importFile.name.endsWith('.md'));
        
      const isVideo = importFile.mimeType ? 
        importFile.mimeType.startsWith('video/') : 
        importFile.type.startsWith('video/');

      const isAudio = importFile.mimeType ? 
        importFile.mimeType.startsWith('audio/') : 
        importFile.type.startsWith('audio/');

      let fileBlob = null;

      // ── 1. Fetch File Content ──
      if (importSource === 'drive') {
        pText.textContent = 'Downloading file from Google Drive...';
        if (isText) {
          content = await downloadDriveFileText(importDriveToken, importFile.id);
        } else {
          fileBlob = await downloadDriveFileBlob(importDriveToken, importFile.id);
        }
      } else {
        pText.textContent = 'Reading local file...';
        if (isText) {
          content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(importFile);
          });
        } else {
          fileBlob = importFile;
        }
      }

      const type = isVideo ? 'video' : (isAudio ? 'audio' : 'text');
      const timestamp = new Date().toISOString();

      if (isText) {
        // Text files are fast, do it synchronously
        pText.textContent = 'Summarizing text content...';
        const summary = await summarizeContent(content, apiKey);
        
        pText.textContent = 'Saving to database...';
        const saved = await saveMemory({
          content: content,
          type: type,
          source: importSource === 'drive' ? 'google-drive' : 'local-upload',
          file_url: importSource === 'drive' ? importFile.webViewLink : null,
          file_name: importFile.name,
          summary: summary,
          metadata: {
            source: importSource === 'drive' ? 'google-drive' : 'local-upload',
            file_name: importFile.name
          }
        });
        const id = saved.id;
        triggerEmbedding(id, content);

        const entry = {
          id:           saved.id,
          timestamp:    saved.created_at || timestamp,
          type:         saved.type,
          content:      saved.content,
          summary:      saved.summary ?? null,
          audioData:    (importSource === 'drive' ? importFile.webViewLink : null),
          audioMimeType:fileBlob ? fileBlob.type : null,
          duration:     null,
          metadata:     saved.metadata ?? {},
          embedding:    [],
        };
        entries.push(entry);
        updateCountBadge();
        renderTimeline();
        setTimeout(() => highlightEntry(id), 120);

        discardSelectedImport();
        showToast('Text file imported successfully!', 'success');
        extractAndSaveEvents(id, content, 'memory');
      } else {
        // Audio/Video files are slow. Save a placeholder immediately and process in background!
        const importFileName = importFile.name;
        const sourceLoc      = importSource;
        const driveFileId    = importFile ? importFile.id : null;
        const driveWebViewLink = importFile ? importFile.webViewLink : null;

        // Create local object URL for immediate in-browser playback
        const localAudioURL = fileBlob ? URL.createObjectURL(fileBlob) : null;

        pText.textContent = 'Creating memory entry...';
        const saved = await saveMemory({
          content: "[Processing media... Transcription and summary will appear here shortly.]",
          type: type,
          source: sourceLoc === 'drive' ? 'google-drive' : 'local-upload',
          file_url: sourceLoc === 'drive' ? driveWebViewLink : null,
          file_name: importFileName,
          summary: null,
          metadata: {
            source: sourceLoc === 'drive' ? 'google-drive' : 'local-upload',
            file_name: importFileName
          }
        });
        const id = saved.id;

        // Render placeholder entry card with the local audio player immediately
        const entry = {
          id:           saved.id,
          timestamp:    saved.created_at || timestamp,
          type:         saved.type,
          content:      saved.content,
          summary:      null,
          audioData:    localAudioURL || (sourceLoc === 'drive' ? driveWebViewLink : null),
          audioMimeType:fileBlob ? fileBlob.type : null,
          duration:     null,
          metadata:     saved.metadata ?? {},
          embedding:    [],
        };
        entries.push(entry);
        updateCountBadge();
        renderTimeline();
        setTimeout(() => highlightEntry(id), 120);

        discardSelectedImport();
        showToast('Media processing started in the background.', 'info');

        // Spawn async background processing flow
        (async () => {
          try {
            // Step 1: If local file, upload in background
            let fileUrlPath = null;
            if (sourceLoc === 'local' && fileBlob) {
              const { path } = await uploadFile(fileBlob, type, `${id}-${importFileName}`);
              fileUrlPath = path;
              await updateMemory({
                id: id,
                file_url: path,
                file_type: fileBlob.type,
                metadata: {
                  source: 'local-upload',
                  file_name: importFileName,
                  storage_path: path
                }
              });
              const entryInList = entries.find(e => e.id === id);
              if (entryInList) entryInList.audioData = path;
            }

            // Step 2: Fetch Drive blob if needed (if ever enabled again)
            let transcribeBlob = fileBlob;

            if (!transcribeBlob) {
              throw new Error('Failed to retrieve file binary blob.');
            }

            // Step 3: Run audio transcription via Groq Whisper API
            const transcribedText = await transcribeAudio(transcribeBlob, apiKey);
            if (!transcribedText.trim()) {
              throw new Error('Transcription completed but returned empty text.');
            }

            // Update content in DB and local state
            await updateMemory({ id: id, content: transcribedText });
            const entryInList = entries.find(e => e.id === id);
            if (entryInList) entryInList.content = transcribedText;
            
            const card = $(`entry-${id}`);
            if (card) {
              card.querySelector('.entry-content').textContent = transcribedText;
            }

            // Step 4: Run content summarization via Groq LLM API
            const summaryText = await summarizeContent(transcribedText, apiKey);
            await updateMemory({ id: id, summary: summaryText });
            if (entryInList) entryInList.summary = summaryText;
            
            if (card) {
              const sumBox = card.querySelector(`#sum-${id}`);
              if (sumBox) {
                sumBox.querySelector('.summary-text').textContent = summaryText;
                sumBox.classList.remove('hidden');
              }
              // Hide summarize button now that summary exists
              card.querySelector('.summarize-btn')?.classList.add('hidden');
            }

            // Step 5: Trigger embeddings generation and event extraction
            triggerEmbedding(id, transcribedText);
            const evSourceType = type === 'video' ? 'video' : 'audio';
            extractAndSaveEvents(id, transcribedText, evSourceType);

            showToast(`Processing complete: "${importFileName}"`, 'success');

          } catch (err) {
            console.error('Background import processing failed:', err);
            showToast(`Processing failed for "${importFileName}": ${err.message}`, 'error');
            
            const entryInList = entries.find(e => e.id === id);
            if (entryInList) {
              entryInList.content = `[Processing failed: ${err.message}]`;
              const card = $(`entry-${id}`);
              if (card) {
                card.querySelector('.entry-content').textContent = entryInList.content;
              }
            }
          }
        })();
      }

    } catch (err) {
      console.error('Import failed:', err);
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      pIndicator.classList.add('hidden');
      btn.disabled = false;
      label.textContent = 'Save memory';
    }
    return;
  }

  const content = currentMode === 'text'
    ? $('thought-input').value.trim()
    : $('transcript-text').textContent.trim();

  if (!content) return;


  // ── Loading state ──
  try {
    const timestamp = new Date().toISOString();

    // 1. Save record to Supabase metadata immediately (so transcript is saved right away)
    const saved = await saveMemory({
      content:      content,
      type:         currentMode === 'audio' ? 'audio' : 'text',
      source:       'manual',
      duration_sec: currentMode === 'audio' ? recSeconds : null,
      metadata:     {},
    });
    const id = saved.id;

    // 2. Trigger server-side embedding (fire-and-forget)
    triggerEmbedding(id, content);

    // 3. Create a local Object URL for immediate in-browser playback
    let localAudioURL = null;
    if (currentMode === 'audio' && audioBlob) {
      localAudioURL = URL.createObjectURL(audioBlob);
    }

    // 4. Map DB row to entry structure and add to local list for instant render
    const entry = {
      id:           saved.id,
      timestamp:    saved.created_at || timestamp,
      type:         saved.type,
      content:      saved.content,
      summary:      saved.summary ?? null,
      audioData:    localAudioURL || saved.file_url || null,
      audioMimeType:saved.file_type || (audioBlob ? audioBlob.type : null),
      duration:     saved.duration_sec ?? (currentMode === 'audio' ? recSeconds : null),
      metadata:     saved.metadata ?? {},
      embedding:    [],
    };

    entries.push(entry);
    updateCountBadge();

    // 5. Render immediately
    renderTimeline();
    setTimeout(() => highlightEntry(id), 120);

    // 6. Start background audio upload to Supabase Storage (non-blocking)
    if (currentMode === 'audio' && audioBlob) {
      const recordedBlob = audioBlob; // capture reference
      const fileName = `${id}.webm`;
      (async () => {
        try {
          const { path } = await uploadFile(recordedBlob, 'audio', fileName);
          // Update DB row with private storage path
          await updateMemory({
            id: id,
            file_url: path,
            file_type: recordedBlob.type,
            metadata: { storage_path: path }
          });
          
          // Update the in-memory entry to use the private path now
          const entryInList = entries.find(e => e.id === id);
          if (entryInList) {
            entryInList.audioData = path;
          }

        } catch (err) {
          console.error('Asynchronous audio upload failed:', err);
          showToast('Failed to upload audio to cloud, but transcript is saved.', 'error');
        }
      })();
    }


    // 7. Reset inputs
    if (currentMode === 'text') {
      $('thought-input').value = '';
      $('char-count').textContent = '0 characters';
    } else {
      currentTranscript = '';
      audioBlob         = null;
      $('transcript-preview').classList.add('hidden');
      $('transcript-text').textContent = '';
    }

    showToast('Memory saved!', 'success');

    // 8. Extract life events in the background (non-blocking)
    const evSrc = currentMode === 'audio' ? 'audio' : 'memory';
    extractAndSaveEvents(id, content, evSrc);

  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    btn.disabled  = false;
    label.textContent = 'Save memory';
    refreshSubmitBtn();
  }
}


function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Related Memories ───────────────────────────────────
function renderRelated(similar) {
  const panel = $('related-panel');
  const list  = $('related-list');

  if (!similar || similar.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  list.innerHTML = '';

  similar.forEach(entry => {
    const pct     = Math.round(entry.similarity * 100);
    const dateStr = formatDateTime(entry.timestamp);
    const snippet = entry.content.slice(0, 130) + (entry.content.length > 130 ? '…' : '');

    const el = document.createElement('div');
    el.className = 'related-item';
    el.dataset.entryId = entry.id;
    el.innerHTML = `
      <div class="related-item-meta">
        <span class="related-item-date">${dateStr}</span>
        <div class="sim-wrap">
          <span class="sim-score">${pct}%</span>
          <div class="sim-bar"><div class="sim-fill" style="width:${pct}%"></div></div>
        </div>
      </div>
      <p class="related-item-text" dir="auto">${esc(snippet)}</p>
    `;
    list.appendChild(el);
  });
}

// ── Timeline ───────────────────────────────────────────
function renderTimeline() {
  const container = $('timeline-container');
  const empty     = $('timeline-empty');
  const loading   = $('timeline-loading');

  if (loading) loading.classList.add('hidden');

  if (entries.length === 0) {
    container.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';

  // Newest first
  const sorted  = [...entries].reverse();
  const grouped = groupByDay(sorted);

  let cardIdx = 1;
  for (const [dayLabel, dayEntries] of grouped) {
    const group = document.createElement('div');
    group.className = 'timeline-day-group';
    group.innerHTML = `
      <div class="timeline-day-header">
        <span class="timeline-day-title">${dayLabel.toUpperCase()}</span>
        <div class="timeline-day-line"></div>
        <span class="timeline-day-count">${dayEntries.length}</span>
      </div>
    `;

    const entriesWrap = document.createElement('div');
    entriesWrap.className = 'timeline-entries';
    dayEntries.forEach(e => {
      entriesWrap.appendChild(buildEntryCard(e, cardIdx++));
    });
    group.appendChild(entriesWrap);
    container.appendChild(group);
  }

  updateCountBadge();
}

function generateWaveformHTML(id, seed) {
  let html = `<div class="waveform-container" id="wave-${id}">`;
  const numSeed = typeof seed === 'number' ? seed : (new Date(seed).getTime() || 1);
  let x = (numSeed % 233280) * 9301 + 49297;
  const count = 48; // matches visual scale
  for (let i = 0; i < count; i++) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const h = Math.round((0.2 + r * 0.8) * 100);
    html += `<span class="wave-bar" style="height: ${h}%"></span>`;
  }
  html += `</div>`;
  return html;
}

function buildEntryCard(entry, displayIndex) {
  const card = document.createElement('article');
  card.className = `entry-card ${entry.type === 'audio' ? 'audio-entry' : ''}`;
  card.id = `entry-${entry.id}`;

  const time  = formatTime(entry.timestamp);
  const indexStr = displayIndex ? displayIndex.toString().padStart(2, '0') : '';

  let badge = '';
  if (entry.type === 'video') {
    badge = '<span class="entry-type-badge entry-type-video" style="display:inline-flex;align-items:center;gap:4px;color:#f97316;border:1px solid #fed7aa;background:rgba(249,115,22,0.05);"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-video"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>VIDEO</span>';
  } else if (entry.type === 'audio') {
    badge = '<span class="entry-type-badge entry-type-audio" style="display:inline-flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>VOICE</span>';
  } else {
    badge = '<span class="entry-type-badge entry-type-text" style="display:inline-flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>TEXT</span>';
  }

  let sourceBadge = '';
  if (entry.metadata?.source === 'google-drive') {
    const filename = entry.metadata.file_name || 'Drive File';
    const fileUrl = entry.audioData || '#';
    sourceBadge = `<a href="${esc(fileUrl)}" target="_blank" class="entry-type-badge entry-type-drive" style="display:inline-flex;align-items:center;gap:4px;color:var(--purple);border:1px solid var(--purple);text-decoration:none;background:rgba(168,85,247,0.05);"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chrome"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" x2="12" y1="8" y2="8"/><line x1="3.95" x2="8.58" y1="6.06" y2="14.07"/><line x1="10.88" x2="15.42" y1="21.94" y2="14.07"/></svg>DRIVE: ${esc(filename)}</a>`;
  } else if (entry.metadata?.source === 'local-upload') {
    const filename = entry.metadata.file_name || 'Local File';
    sourceBadge = `<span class="entry-type-badge entry-type-local" style="display:inline-flex;align-items:center;gap:4px;color:var(--text-2);border:1px solid var(--border);"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-upload"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>LOCAL: ${esc(filename)}</span>`;
  }


  let audioHTML = '';
  if (entry.type === 'audio') {
    if (entry.audioData) {
      const isPrivatePath = !entry.audioData.startsWith('blob:') && !entry.audioData.startsWith('http');
      const audioSrc = isPrivatePath ? '' : entry.audioData;
      const storageAttr = isPrivatePath ? `data-storage-path="${entry.audioData}"` : '';
      const durationText = entry.duration ? fmtSecs(entry.duration) : '--:--';
      audioHTML = `
        <audio id="aud-${entry.id}" src="${audioSrc}" ${storageAttr} preload="auto"></audio>
        <div class="audio-player" id="player-${entry.id}">

          <button class="audio-play-btn" data-audio-id="${entry.id}" aria-label="Play recording"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg></button>
          <div class="player-timeline">
            <div class="player-scrubber-wrap">
              ${generateWaveformHTML(entry.id, entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now())}
              <input class="player-scrubber" id="scrub-${entry.id}"
                type="range" min="0" max="${entry.duration || 100}" step="0.01" value="0"
                aria-label="Seek through recording" />
            </div>
          </div>
          <div class="player-controls-right" style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            <span class="player-time" id="time-display-${entry.id}">0:00 / ${durationText}</span>
            <button class="player-speed-btn" data-speed-id="${entry.id}" aria-label="Playback speed">1×</button>
          </div>
        </div>
      `;
    } else {
      audioHTML = `
        <div class="audio-player audio-preparing" id="player-${entry.id}">
          <div class="audio-preparing-placeholder" style="font-family: monospace; font-size: 11px; color: var(--text-3); padding: var(--s2) 0; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; width: 100%;">
            <span class="preparing-spinner" style="display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--text-3); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; flex-shrink: 0;"></span>
            Preparing audio...
          </div>
        </div>
      `;
    }
  }


  const hasSummary = !!entry.summary;
  const summaryHTML = `
    <div class="summary-box ${hasSummary ? '' : 'hidden'}" id="sum-${entry.id}" style="margin-top: var(--s3); background: var(--surface-hover); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s3); font-size: 13px; color: var(--text-2); display: flex; flex-direction: column; gap: var(--s2);">
      <div style="display: flex; gap: var(--s2); align-items: flex-start;">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles" style="color: var(--purple); flex-shrink: 0; margin-top: 2px;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/><path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5Z"/><path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z"/></svg>
        <span class="summary-text" style="flex: 1; line-height: 1.4;">${hasSummary ? esc(entry.summary) : ''}</span>
      </div>
      <div class="summary-actions-row" style="display: flex; gap: var(--s3); justify-content: flex-end; margin-top: var(--s1); border-top: 1px dashed var(--border); padding-top: var(--s2);">
        <button class="btn-undo-summary" data-undo-id="${entry.id}" style="background: none; border: none; font-family: inherit; font-size: 11px; color: var(--text-3); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px;" title="Remove summary">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          Undo
        </button>
      </div>
    </div>
  `;

  card.innerHTML = `
    <div class="entry-meta">
      <div class="entry-meta-left">
        ${badge}
        ${sourceBadge}
        <span class="entry-time">${time}</span>
      </div>
      <div class="entry-meta-right">

        <button class="entry-delete-btn" data-delete-id="${entry.id}" aria-label="Delete memory" title="Delete memory"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
        <span class="entry-index">${indexStr}</span>
      </div>
    </div>
    <p class="entry-content" dir="auto">${esc(entry.content)}</p>
    ${audioHTML}
    <button class="summarize-btn ${hasSummary ? 'hidden' : ''}" data-summarize-id="${entry.id}" aria-label="Summarize">
      + Summary
    </button>
    ${summaryHTML}
  `;

  // Wire audio player events directly after innerHTML is set
  if (entry.audioData) {
    const aud  = card.querySelector(`#aud-${entry.id}`);
    const scrub = card.querySelector(`#scrub-${entry.id}`);
    const timeDisplay = card.querySelector(`#time-display-${entry.id}`);
    const bars = card.querySelectorAll(`#wave-${entry.id} .wave-bar`);

    function setFill(pct) {
      const activeCount = Math.floor((pct / 100) * bars.length);
      bars.forEach((bar, index) => {
        if (index <= activeCount) {
          bar.classList.add('active');
        } else {
          bar.classList.remove('active');
        }
      });
    }

    function applyDuration() {
      const dur = (isFinite(aud.duration) && aud.duration > 0) ? aud.duration : entry.duration;
      if (dur) {
        timeDisplay.textContent = `${fmtSecs(aud.currentTime)} / ${fmtSecs(dur)}`;
        scrub.max = dur;
      }
    }

    // loadedmetadata + durationchange cover all browser/data-URL timing cases
    aud.addEventListener('loadedmetadata', () => {
      if (aud.duration === Infinity) {
        aud.currentTime = 1e9;
        aud.ontimeupdate = () => {
          aud.ontimeupdate = null;
          aud.currentTime = 0;
          applyDuration();
        };
      } else {
        applyDuration();
      }
    });
    aud.addEventListener('durationchange', applyDuration);

    // If already parsed (data URL may load synchronously in some browsers)
    if (aud.readyState >= 1) applyDuration();
    // Fallback: force a load after the card hits the DOM
    setTimeout(() => { if (!isFinite(aud.duration) || aud.duration === 0) aud.load(); }, 0);

    aud.addEventListener('timeupdate', () => {
      const dur = (isFinite(aud.duration) && aud.duration > 0) ? aud.duration : entry.duration;
      if (dur) {
        timeDisplay.textContent = `${fmtSecs(aud.currentTime)} / ${fmtSecs(dur)}`;
        scrub.value = aud.currentTime;
        setFill((aud.currentTime / dur) * 100);
      }
    });

    aud.addEventListener('ended', () => {
      const btn = card.querySelector(`[data-audio-id="${entry.id}"]`);
      if (btn) btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
      scrub.value = 0;
      setFill(0);
      const dur = (isFinite(aud.duration) && aud.duration > 0) ? aud.duration : entry.duration;
      timeDisplay.textContent = `0:00 / ${fmtSecs(dur)}`;
    });

    scrub.addEventListener('input', () => {
      aud.currentTime = Number(scrub.value);
      const dur = (isFinite(aud.duration) && aud.duration > 0) ? aud.duration : entry.duration;
      if (dur) setFill((Number(scrub.value) / dur) * 100);
    });
  }

  return card;
}

/** Format seconds → m:ss */
function fmtSecs(s) {
  if (!isFinite(s) || isNaN(s)) return '--:--';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}



// ── Entry interactions (delegated) ─────────────────────
function setupEntryInteractions() {
  if (entryInteractionsRegistered) return;
  entryInteractionsRegistered = true;

  document.addEventListener('click', async (e) => {

    // Expand / collapse card (avoid triggering on buttons)
    const card = e.target.closest('.entry-card');
    if (card && !e.target.closest('button')) {
      card.classList.toggle('expanded');
    }

    // Delete button
    const delBtn = e.target.closest('[data-delete-id]');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.deleteId;
      await handleDeleteEntry(id);
    }

    // Audio play button
    const playBtn = e.target.closest('[data-audio-id]');
    if (playBtn) {
      e.stopPropagation();
      const id  = playBtn.dataset.audioId;
      const aud = document.getElementById(`aud-${id}`);
      if (!aud) return;

      if (aud.paused) {
        // 1. If it's a private storage path and src is empty, fetch a secure signed URL dynamically
        if (!aud.src || aud.src === window.location.href || aud.src === '') {
          const path = aud.dataset.storagePath;
          if (path) {
            playBtn.disabled = true;
            playBtn.innerHTML = '<span class="preparing-spinner" style="display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--text-3); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; flex-shrink: 0;"></span>';
            try {
              const { getSignedUrl } = await import('./services/storage.js');
              const signedUrl = await getSignedUrl(path);
              aud.src = signedUrl;
              aud.load();

              // Wait for metadata to load to ensure playback starts properly
              await new Promise((resolve) => {
                const onLoaded = () => {
                  aud.removeEventListener('loadedmetadata', onLoaded);
                  aud.removeEventListener('error', onError);
                  resolve();
                };
                const onError = () => {
                  aud.removeEventListener('loadedmetadata', onLoaded);
                  aud.removeEventListener('error', onError);
                  resolve(); // resolve anyway to attempt play
                };
                aud.addEventListener('loadedmetadata', onLoaded);
                aud.addEventListener('error', onError);
                setTimeout(onLoaded, 1000); // safety timeout
              });
            } catch (err) {
              console.error('Failed to load signed URL:', err);
              showToast('Failed to load private audio link.', 'error');
              playBtn.disabled = false;
              playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
              return;
            } finally {
              playBtn.disabled = false;
            }
          }
        }

        // Pause any other playing audio
        document.querySelectorAll('audio').forEach(a => { if (a !== aud) { a.pause(); } });
        document.querySelectorAll('[data-audio-id]').forEach(b => {
          b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
        });
        
        aud.play().catch(err => {
          console.warn('Playback interrupted:', err);
        });
        
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause"><rect width="4" height="16" x="14" y="4" rx="1"/><rect width="4" height="16" x="6" y="4" rx="1"/></svg>';
        aud.onended = () => {
          playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
        };
      } else {
        aud.pause();
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
      }
    }


    // Speed toggle (1× → 1.5× → 2× → 1×)
    const speedBtn = e.target.closest('[data-speed-id]');
    if (speedBtn) {
      e.stopPropagation();
      const aud = document.getElementById(`aud-${speedBtn.dataset.speedId}`);
      if (!aud) return;
      const rates = [1, 1.5, 2];
      const next  = rates[(rates.indexOf(aud.playbackRate) + 1) % rates.length];
      aud.playbackRate    = next;
      speedBtn.textContent = `${next}×`;
      return;
    }

    // Summarize button
    const sumBtn = e.target.closest('[data-summarize-id]');
    if (sumBtn) {
      e.stopPropagation();
      await handleSummarize(sumBtn);
      return;
    }

    // Undo summary button
    const undoBtn = e.target.closest('[data-undo-id]');
    if (undoBtn) {
      e.stopPropagation();
      await handleUndoSummary(undoBtn);
      return;
    }

    // Related item → scroll to entry
    const relItem = e.target.closest('.related-item');
    if (relItem) {
      const targetId = relItem.dataset.entryId;
      if (targetId) highlightEntry(targetId);
    }
  });
}

function highlightEntry(id) {
  document.querySelectorAll('.entry-card.highlighted').forEach(c => c.classList.remove('highlighted'));
  const card = $(`entry-${id}`);
  if (!card) return;
  card.classList.add('highlighted');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => card.classList.remove('highlighted'), 3500);
}

async function handleDeleteEntry(id) {
  const card = $(`entry-${id}`);
  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(12px)';
    await new Promise(r => setTimeout(r, 200));
  }

  // Find entry in local list before deleting to remove private audio/video file if exists
  const entry = entries.find(e => e.id === id);
  if (entry && (entry.type === 'audio' || entry.type === 'video') && entry.audioData) {
    const isPrivatePath = !entry.audioData.startsWith('blob:') && !entry.audioData.startsWith('http');
    if (isPrivatePath) {
      try {
        const { deleteFile } = await import('./services/storage.js');
        await deleteFile(entry.audioData);

      } catch (err) {
        console.warn('Failed to delete file from bucket:', err);
      }
    }
  }


  await deleteMemory(id);
  await deleteEventsByMemoryId(id);   // clean up extracted events too
  entries = entries.filter(e => e.id !== id);
  updateCountBadge();
  renderTimeline();

  const relatedIds = [...document.querySelectorAll('.related-item')].map(el => el.dataset.entryId);
  if (relatedIds.includes(id)) $('related-panel').classList.add('hidden');

  showToast('Memory deleted.', 'info');
}


// ── Summarize ──────────────────────────────────────────
async function handleSummarize(btn) {
  const id      = btn.dataset.summarizeId;
  const sumBox  = $(`sum-${id}`);
  const entry   = entries.find(e => e.id === id);
  if (!entry) return;

  // Toggle if already has summary
  if (entry.summary) {
    sumBox.classList.toggle('hidden');
    return;
  }

  // Show spinner
  btn.innerHTML = '<span class="sum-spinner"></span> Summarizing…';
  btn.disabled = true;

  try {
    const summary = await summarizeContent(entry.content, getGroqKey());

    // Persist summary update to Supabase
    entry.summary = summary;
    await updateMemory({ id: entry.id, summary });

    // Update UI
    sumBox.textContent = summary;
    sumBox.classList.remove('hidden');
    btn.innerHTML  = '✦ Summary';
    btn.classList.add('has-summary');
  } catch (err) {
    showToast(`Summarize failed: ${err.message}`, 'error');
    btn.innerHTML = '✦ Summarize';
  } finally {
    btn.disabled = false;
  }
}

async function handleUndoSummary(btn) {
  const id = btn.dataset.undoId;
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  btn.disabled = true;
  try {
    entry.summary = null;
    await updateMemory({ id: entry.id, summary: null });

    const card = $(`entry-${id}`);
    if (card) {
      card.querySelector(`#sum-${id}`).classList.add('hidden');
      
      const sumBtn = card.querySelector('.summarize-btn');
      if (sumBtn) {
        sumBtn.classList.remove('hidden');
      }
    }
    showToast('Summary removed.', 'info');
  } catch (err) {
    showToast(`Undo failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}


// ── Event Extraction ───────────────────────────────────
async function extractAndSaveEvents(memoryId, content, sourceType = 'memory') {
  const key = getGroqKey();
  if (!key) return;


  try {
    const events = await extractEvents(content, key);

    let foundNew = false;
    for (const ev of events) {
      pendingEvents.push({
        id:            crypto.randomUUID(),
        memoryId,
        memory_id:     memoryId,
        sourceType,
        source_type:   sourceType,
        date:          ev.date,
        title:         ev.title,
        description:   ev.description,
        memorySnippet: content.slice(0, 100)
      });
      foundNew = true;
    }
    if (foundNew) {
      showPendingEventsModal();
    }
  } catch (err) {
    console.error('Failed to extract events during ingestion:', err);
  }
}


// ── Events Timeline Render ─────────────────────────────
async function renderEventsTimeline() {
  const container = $('events-container');
  const empty     = $('events-empty');
  const loading   = $('events-loading');

  if (loading) loading.classList.remove('hidden');
  container.classList.add('hidden');
  empty.classList.add('hidden');

  let allEvents = [];
  try {
    allEvents = await getAllEvents();
  } catch (err) {
    console.error('Failed to load life events:', err);
    showToast('Failed to load life events.', 'error');
  } finally {
    if (loading) loading.classList.add('hidden');
  }

  // Sort descending: most recent year/date first
  const sortedEvents = [...allEvents].sort((a, b) => b.date.localeCompare(a.date));

  eventsCache.clear();
  sortedEvents.forEach(ev => eventsCache.set(ev.id, ev));
  eventsCount = sortedEvents.length;
  updateCountBadge();

  if (sortedEvents.length === 0) {
    container.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';

  // Group by year (Maps preserve insertion order, so newest years will render first)
  const byYear = new Map();
  for (const ev of sortedEvents) {
    const year = ev.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(ev);
  }

  for (const [year, yearEvents] of byYear) {

    const group = document.createElement('div');
    group.className = 'events-year-group';
    group.innerHTML = `<div class="events-year-label">${year}</div>`;

    const list = document.createElement('div');
    list.className = 'events-list';

    for (const ev of yearEvents) {
      list.appendChild(buildEventCard(ev));
    }

    group.appendChild(list);
    container.appendChild(group);
  }
}

function buildEventCard(ev) {
  // Normalise DB snake_case → camelCase (events from Supabase use memory_id / source_type)
  const memoryId   = ev.memoryId   ?? ev.memory_id   ?? null;
  const sourceType = ev.sourceType ?? ev.source_type ?? 'memory';

  const d       = new Date(ev.date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const year    = ev.date.slice(0, 4);

  // ── Source tag config ────────────────────────────────
  const tagConfig = {
    memory: {
      label: 'From Memory',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
      color: 'var(--accent)',
      clickable: !!memoryId,
    },
    audio: {
      label: 'From Audio',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
      color: '#8b5cf6',
      clickable: !!memoryId,
    },
    video: {
      label: 'From Video',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`,
      color: '#f59e0b',
      clickable: !!memoryId,
    },
    manual: {
      label: 'Added manually',
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
      color: 'var(--text-3)',
      clickable: false,
    },
  };
  const tag = tagConfig[sourceType] ?? tagConfig.memory;

  // ── Memory link label (date of source memory) ────────
  let sourceLabel = 'View source memory';
  if (memoryId) {
    const srcEntry = entries.find(e => e.id === memoryId);
    if (srcEntry?.timestamp) {
      const memDate = new Date(srcEntry.timestamp);
      sourceLabel = memDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }
  }

  const card = document.createElement('div');
  card.className   = 'event-card';
  card.dataset.eventId = ev.id;

  card.innerHTML = `
    <!-- ── View mode ── -->
    <div class="event-view">
      <div class="event-card-actions">
        <div class="event-date-badge" style="display:inline-flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-days"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>${dateStr}, ${year}</div>
        <div class="event-action-btns">
          <button class="event-edit-btn" data-edit-event="${ev.id}" aria-label="Edit event" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="m15 5 3 3"/></svg></button>
          <button class="event-delete-btn" data-delete-event="${ev.id}" aria-label="Delete event" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
        </div>
      </div>
      <div class="event-title" dir="auto">${esc(ev.title)}</div>
      <p class="event-description" dir="auto">${esc(ev.description)}</p>
      <div class="event-source${tag.clickable ? '' : ' event-source--static'}"
           ${tag.clickable ? `data-source-memory="${memoryId}" role="button" tabindex="0" title="Jump to source memory"` : ''}
           style="--tag-color:${tag.color}">
        <span class="event-source-icon">${tag.icon}</span>
        <span class="event-source-label">${tag.label}</span>
        ${tag.clickable ? `
        <span class="event-source-divider">/</span>
        <span class="event-source-text">${esc(sourceLabel)}</span>
        <span class="event-source-arrow" style="display:inline-flex;align-items:center;margin-left:2px;"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg></span>` : ''}
      </div>
    </div>

    <!-- ── Edit mode (hidden by default) ── -->
    <div class="event-edit-form hidden">
      <div class="event-form-row">
        <label class="event-form-label">Date</label>
        <input class="event-date-input input-field" type="date" value="${ev.date}" data-field="date" />
      </div>
      <div class="event-form-row">
        <label class="event-form-label">Title</label>
        <input class="event-title-input input-field" type="text" value="${esc(ev.title)}" dir="auto" data-field="title" />
      </div>
      <div class="event-form-row">
        <label class="event-form-label">Details</label>
        <textarea class="event-desc-input input-field" rows="3" dir="auto" data-field="description">${esc(ev.description)}</textarea>
      </div>
      <div class="event-edit-actions">
        <button class="btn btn-primary btn-sm" data-save-event="${ev.id}">✓ Save</button>
        <button class="btn btn-ghost btn-sm" data-cancel-event="${ev.id}">Cancel</button>
      </div>
    </div>
  `;
  return card;
}

// Delegated events for the events container (edit / save / cancel)
function setupEventsInteractions() {
  if (eventInteractionsRegistered) return;
  eventInteractionsRegistered = true;

  $('events-container').addEventListener('click', async (e) => {

    // ── Jump to source memory ──
    const srcLink = e.target.closest('[data-source-memory]');
    if (srcLink) {
      const memoryId = srcLink.dataset.sourceMemory;
      switchView('memories');          // flip to Memories tab
      await renderEventsTimeline();    // keep events fresh for next visit
      setTimeout(() => highlightEntry(memoryId), 80); // wait for DOM
      return;
    }

    // ── Delete ──
    const delBtn = e.target.closest('[data-delete-event]');
    if (delBtn) {
      const id   = delBtn.dataset.deleteEvent;
      const card = delBtn.closest('.event-card');

      // Animate out
      card.style.transition = 'opacity 0.2s, transform 0.2s';
      card.style.opacity    = '0';
      card.style.transform  = 'translateX(12px)';
      await new Promise(r => setTimeout(r, 200));

      await deleteEvent(id);
      eventsCache.delete(id);
      showToast('Event deleted.', 'info');
      await renderEventsTimeline();
      return;
    }

    // ── Edit ──
    const editBtn = e.target.closest('[data-edit-event]');
    if (editBtn) {
      const card = editBtn.closest('.event-card');
      card.querySelector('.event-view').classList.add('hidden');
      card.querySelector('.event-edit-form').classList.remove('hidden');
      card.querySelector('.event-title-input').focus();
      return;
    }

    // ── Cancel ──
    const cancelBtn = e.target.closest('[data-cancel-event]');
    if (cancelBtn) {
      const card = cancelBtn.closest('.event-card');
      // Reset inputs to original values
      const id = cancelBtn.dataset.cancelEvent;
      const original = eventsCache.get(id);
      if (original) {
        card.querySelector('.event-date-input').value = original.date;
        card.querySelector('.event-title-input').value = original.title;
        card.querySelector('.event-desc-input').value = original.description;
      }
      card.querySelector('.event-edit-form').classList.add('hidden');
      card.querySelector('.event-view').classList.remove('hidden');
      return;
    }

    // ── Save ──
    const saveBtn = e.target.closest('[data-save-event]');
    if (saveBtn) {
      const id   = saveBtn.dataset.saveEvent;
      const card = saveBtn.closest('.event-card');
      const form = card.querySelector('.event-edit-form');

      const newDate  = form.querySelector('.event-date-input').value.trim();
      const newTitle = form.querySelector('.event-title-input').value.trim();
      const newDesc  = form.querySelector('.event-desc-input').value.trim();

      if (!newDate || !newTitle) {
        showToast('Date and title are required.', 'error');
        return;
      }

      // Disable save while persisting
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      try {
        const existing = eventsCache.get(id);
        const updated  = { ...existing, date: newDate, title: newTitle, description: newDesc };
        await updateEvent(updated);
        eventsCache.set(id, updated);
        showToast('Event updated!', 'success');
        // Re-render the full timeline (dates may shift year groups)
        await renderEventsTimeline();
      } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = '✓ Save';
      }
      return;
    }
  });

  // ── Keyboard a11y: Enter/Space on source link ──
  $('events-container').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const srcLink = e.target.closest('[data-source-memory]');
      if (srcLink) { e.preventDefault(); srcLink.click(); }
    }
  });
}

// ── Manual Add Event ────────────────────────────────────
function setupAddEventBtn() {
  const btn = $('add-event-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // If inline form already exists, focus it
    const existing = document.getElementById('manual-event-form');
    if (existing) { existing.querySelector('input[type="date"]').focus(); return; }

    const form = document.createElement('div');
    form.id = 'manual-event-form';
    form.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s4);margin-bottom:var(--s4);display:flex;flex-direction:column;gap:var(--s3);';
    form.innerHTML = `
      <div style="font-weight:600;font-size:13px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">New Life Event</div>
      <div class="event-form-row">
        <label class="event-form-label">Date</label>
        <input id="manual-ev-date" class="event-date-input input-field" type="date" value="${new Date().toISOString().slice(0,10)}" />
      </div>
      <div class="event-form-row">
        <label class="event-form-label">Title</label>
        <input id="manual-ev-title" class="event-title-input input-field" type="text" dir="auto" placeholder="e.g. Started university" />
      </div>
      <div class="event-form-row">
        <label class="event-form-label">Details</label>
        <textarea id="manual-ev-desc" class="event-desc-input input-field" rows="2" dir="auto" placeholder="Optional description…"></textarea>
      </div>
      <div class="event-edit-actions">
        <button id="manual-ev-save" class="btn btn-primary btn-sm">✓ Add to Timeline</button>
        <button id="manual-ev-cancel" class="btn btn-ghost btn-sm">Cancel</button>
      </div>
    `;

    const container = $('events-container');
    const viewEl    = $('view-events');

    // Insert before timeline or at start of view
    if (container && !container.classList.contains('hidden')) {
      viewEl.insertBefore(form, container);
    } else {
      viewEl.insertBefore(form, viewEl.querySelector('#events-empty'));
    }

    form.querySelector('#manual-ev-cancel').addEventListener('click', () => form.remove());

    form.querySelector('#manual-ev-save').addEventListener('click', async () => {
      const date  = form.querySelector('#manual-ev-date').value.trim();
      const title = form.querySelector('#manual-ev-title').value.trim();
      const desc  = form.querySelector('#manual-ev-desc').value.trim();
      if (!date || !title) { showToast('Date and title are required.', 'error'); return; }

      const saveBtn = form.querySelector('#manual-ev-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      try {
        await saveEvent({ date, title, description: desc, memoryId: null, sourceType: 'manual' });
        showToast('Event added!', 'success');
        form.remove();
        await renderEventsTimeline();
      } catch (err) {
        showToast(`Failed: ${err.message}`, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = '✓ Add to Timeline';
      }
    });

    form.querySelector('#manual-ev-date').focus();
  });
}

// ── Pending Events UI ──────────────────────────────────
function setupPendingEvents() {
  if (pendingEventsRegistered) return;
  pendingEventsRegistered = true;

  $('close-pending-btn').addEventListener('click', hidePendingEventsModal);

  $('approve-all-pending-btn').addEventListener('click', async () => {
    // Save all pending events
    for (const ev of pendingEvents) {
      // Re-read inputs if they were edited inline
      const card = $(`pending-card-${ev.id}`);
      if (card) {
        ev.title = card.querySelector('.pending-title').value.trim();
        ev.date = card.querySelector('.pending-date').value.trim();
        ev.description = card.querySelector('.pending-event-desc').value.trim();
      }
      if (ev.title && ev.date) await saveEvent(ev);
    }
    pendingEvents = [];
    hidePendingEventsModal();
    if ($('vtab-events').classList.contains('active')) {
      await renderEventsTimeline();
    } else {
      eventsCount += pendingEvents.length;
      updateCountBadge();
    }
    showToast('All pending life events approved!', 'success');
  });

  $('pending-events-list').addEventListener('click', async (e) => {
    const approveBtn = e.target.closest('.btn-approve');
    const rejectBtn = e.target.closest('.btn-reject');
    
    if (approveBtn) {
      const id = approveBtn.dataset.id;
      const evIndex = pendingEvents.findIndex(ev => ev.id === id);
      if (evIndex > -1) {
        const ev = pendingEvents[evIndex];
        const card = $(`pending-card-${id}`);
        ev.title = card.querySelector('.pending-title').value.trim();
        ev.date = card.querySelector('.pending-date').value.trim();
        ev.description = card.querySelector('.pending-event-desc').value.trim();
        
        if (!ev.title || !ev.date) {
          showToast('Date and title are required.', 'error');
          return;
        }
        
        await saveEvent(ev);
        pendingEvents.splice(evIndex, 1);
        renderPendingEvents();
        
        if (pendingEvents.length === 0) hidePendingEventsModal();
        
        if ($('vtab-events').classList.contains('active')) {
          await renderEventsTimeline();
        } else {
          eventsCount++;
          updateCountBadge();
        }
        showToast('Life event approved!', 'success');
      }
    }
    
    if (rejectBtn) {
      const id = rejectBtn.dataset.id;
      const evIndex = pendingEvents.findIndex(ev => ev.id === id);
      if (evIndex > -1) {
        pendingEvents.splice(evIndex, 1);
        renderPendingEvents();
        if (pendingEvents.length === 0) hidePendingEventsModal();
      }
    }
  });
}

function showPendingEventsModal() {
  renderPendingEvents();
  $('pending-events-modal').classList.remove('hidden');
}

function hidePendingEventsModal() {
  $('pending-events-modal').classList.add('hidden');
}

function renderPendingEvents() {
  const container = $('pending-events-list');
  if (pendingEvents.length === 0) {
    container.innerHTML = '<p style="color:var(--text-2);">No pending events.</p>';
    return;
  }
  
  container.innerHTML = pendingEvents.map(ev => `
    <div class="pending-event-card" id="pending-card-${ev.id}">
      <div class="pending-event-row">
        <input type="text" class="pending-title" value="${esc(ev.title)}" placeholder="Event Title" />
        <input type="text" class="pending-date" value="${esc(ev.date)}" placeholder="Date (e.g., 2026-03)" />
      </div>
      <textarea class="pending-event-desc" placeholder="Description">${esc(ev.description || '')}</textarea>
      <div class="pending-event-actions">
        <button class="btn btn-sm btn-reject" data-id="${ev.id}">Delete</button>
        <button class="btn btn-sm btn-approve" data-id="${ev.id}">Approve</button>
      </div>
    </div>
  `).join('');
}

// ── Utilities ──────────────────────────────────────────
function groupByDay(sortedEntries) {
  const map = new Map(); // preserves insertion order
  sortedEntries.forEach(e => {
    const label = dayLabel(new Date(e.timestamp));
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(e);
  });
  return map;
}

function dayLabel(date) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d     = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff  = Math.round((today - d) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function updateCountBadge() {
  const onEvents = $('vtab-events').classList.contains('active');
  const el = $('entry-count');
  if (onEvents) {
    el.textContent = `${eventsCount} ${eventsCount === 1 ? 'event' : 'events'}`;
  } else {
    const n = entries.length;
    el.textContent = `${n} ${n === 1 ? 'memory' : 'memories'}`;
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

// ── Toast ──────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s forwards';
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

// ── Start ──────────────────────────────────────────────
bootAuth();
