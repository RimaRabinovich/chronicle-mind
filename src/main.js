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
import { saveMemory, getAllMemories, deleteMemory, updateMemory } from './services/memories.js';
import { saveEvent, updateEvent, deleteEvent, getAllEvents, deleteEventsByMemoryId } from './services/events.js';
import { triggerEmbedding } from './services/rag.js';
import { uploadFile } from './services/storage.js';

// ── Other utilities ───────────────────────────────────────────────────
import { transcribeAudio }           from './transcription.js';
import { AudioRecorder }             from './recorder.js';
import { summarizeContent, extractEvents } from './ai.js';
import { initAuth, signInWithGoogle, signOutUser, onAuthChange } from './auth.js';


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

// ── Boot ───────────────────────────────────────────────
/** Called once after a user is confirmed signed-in */
async function init() {
  try {
    await loadMemories();
    renderTimeline();
    setupViewTabs();
    setupTabs();
    setupRecorder();
    setupSubmit();
    setupEntryInteractions();
    setupEventsInteractions();
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

  // Sign-out button in the header
  $('signout-btn').addEventListener('click', async () => {
    await signOutUser();
    // Reset in-memory state so re-login starts fresh
    entries = [];
    eventsCount = 0;
    pendingEvents = [];
    eventsCache.clear();
    audioURLs.clear();
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
  $('tab-text').addEventListener('click',  () => switchTab('text'));
  $('tab-audio').addEventListener('click', () => switchTab('audio'));

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
  const isText  = mode === 'text';

  $('tab-text').classList.toggle('active', isText);
  $('tab-audio').classList.toggle('active', !isText);
  $('tab-text').setAttribute('aria-selected', String(isText));
  $('tab-audio').setAttribute('aria-selected', String(!isText));

  $('panel-text').classList.toggle('active', isText);
  $('panel-audio').classList.toggle('active', !isText);

  refreshSubmitBtn();
}

// ── Recorder ───────────────────────────────────────────
function setupRecorder() {
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

// ── Submit ─────────────────────────────────────────────
function setupSubmit() {
  $('submit-btn').addEventListener('click', handleSubmit);
}

function refreshSubmitBtn() {
  const hasText  = currentMode === 'text'  && $('thought-input').value.trim().length > 0;
  const hasAudio = currentMode === 'audio' && currentTranscript.trim().length > 0;
  $('submit-btn').disabled = !hasText && !hasAudio;
}

async function handleSubmit() {
  const content = currentMode === 'text'
    ? $('thought-input').value.trim()
    : currentTranscript.trim();

  if (!content) return;

  // ── Loading state ──
  const btn   = $('submit-btn');
  const label = $('submit-label');
  btn.disabled  = true;
  label.textContent = 'Saving…';

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

    entries.unshift(entry);
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
          const { publicUrl, path } = await uploadFile(recordedBlob, 'audio', fileName);
          // Update DB row with public storage URL
          await updateMemory({
            id: id,
            file_url: publicUrl,
            file_type: recordedBlob.type,
            metadata: { storage_path: path }
          });
          
          // Update the in-memory entry to use the persistent URL now
          const entryInList = entries.find(e => e.id === id);
          if (entryInList) {
            entryInList.audioData = publicUrl;
            // No need to rebuild entirely if user is currently playing, but updating ensures next render is persistent
          }
          console.log('Background upload completed successfully:', publicUrl);
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
    extractAndSaveEvents(id, content);

  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
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

  const badge = entry.type === 'audio'
    ? '<span class="entry-type-badge entry-type-audio" style="display:inline-flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mic"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>VOICE</span>'
    : '<span class="entry-type-badge entry-type-text" style="display:inline-flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>TEXT</span>';

  let audioHTML = '';
  if (entry.type === 'audio') {
    if (entry.audioData) {
      const durationText = entry.duration ? fmtSecs(entry.duration) : '--:--';
      audioHTML = `
        <audio id="aud-${entry.id}" src="${entry.audioData}" preload="auto"></audio>
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
  const summaryHTML = hasSummary
    ? `<div class="summary-box" id="sum-${entry.id}">
         <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles" style="color: var(--purple); flex-shrink: 0; margin-top: 2px;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/><path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5Z"/><path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z"/></svg>
         <span>${esc(entry.summary)}</span>
       </div>`
    : `<div class="summary-box hidden" id="sum-${entry.id}"></div>`;

  card.innerHTML = `
    <div class="entry-meta">
      <div class="entry-meta-left">
        ${badge}
        <span class="entry-time">${time}</span>
      </div>
      <div class="entry-meta-right">
        <button class="entry-delete-btn" data-delete-id="${entry.id}" aria-label="Delete memory" title="Delete memory"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
        <span class="entry-index">${indexStr}</span>
      </div>
    </div>
    <p class="entry-content" dir="auto">${esc(entry.content)}</p>
    ${audioHTML}
    ${hasSummary ? '' : `
      <button class="summarize-btn" data-summarize-id="${entry.id}" aria-label="Summarize">
        + Summary
      </button>
    `}
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
        // Pause any other playing audio
        document.querySelectorAll('audio').forEach(a => { if (a !== aud) { a.pause(); } });
        document.querySelectorAll('[data-audio-id]').forEach(b => {
          b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
        });
        aud.play();
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

// ── Event Extraction ───────────────────────────────────
async function extractAndSaveEvents(memoryId, content) {
  const key = getGroqKey();
  if (!key) return;

  try {
    const events = await extractEvents(content, key);
    let foundNew = false;
    for (const ev of events) {
      pendingEvents.push({
        id:            crypto.randomUUID(),
        memoryId,
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
  } catch {
    // Silent fail — event extraction is best-effort
  }
}

// ── Events Timeline Render ─────────────────────────────
async function renderEventsTimeline() {
  const container = $('events-container');
  const empty     = $('events-empty');

  const allEvents = await getAllEvents(); // sorted by date asc
  eventsCache.clear();
  allEvents.forEach(ev => eventsCache.set(ev.id, ev));
  eventsCount = allEvents.length;
  updateCountBadge();

  if (allEvents.length === 0) {
    container.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.classList.remove('hidden');
  container.innerHTML = '';

  // Group by year
  const byYear = new Map();
  for (const ev of allEvents) {
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
  const d       = new Date(ev.date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const year    = ev.date.slice(0, 4);

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
      <div class="event-source" data-source-memory="${ev.memoryId}" role="button" tabindex="0" title="Jump to memory">
        <span class="event-source-arrow" style="display:inline-flex;align-items:center;"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg></span>
        <span class="event-source-label">FROM MEMORY</span>
        <span class="event-source-divider">/</span>
        <span class="event-source-text">${esc(ev.memorySnippet)}…</span>
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
}

// ── Pending Events UI ──────────────────────────────────
function setupPendingEvents() {
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
