/**
 * main.js — Chronicle Mind App Orchestrator
 *
 * Responsibilities:
 *  - Boot: init DB, load entries, start embedder worker, render timeline
 *  - Capture: text textarea + audio recorder → Groq Whisper transcription
 *  - Embed: send content to worker, await Float32 embedding
 *  - Save: persist entry to IndexedDB
 *  - Related: cosine similarity search → render related-memories panel
 *  - Timeline: chronological render, day-grouped, expandable cards
 */

import './style.css';
import { saveEntry, getAllEntries, deleteEntry, saveEvent, updateEvent, deleteEvent, getAllEvents, deleteEventsByMemoryId } from './db.js';
import { findSimilar }               from './embeddings.js';
import { transcribeAudio }           from './transcription.js';
import { AudioRecorder }             from './recorder.js';
import { summarizeContent, extractEvents } from './ai.js';

// ── DOM helpers ────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── App State ──────────────────────────────────────────
let entries       = [];          // all stored entries (chronological)
let embedderReady = false;       // true once model finished loading
let embedderWorker= null;        // Web Worker reference
let pendingEmbed  = new Map();   // id → { resolve, reject }
let currentMode   = 'text';      // 'text' | 'audio'
let currentTranscript = '';      // transcript from last recording
let audioBlob     = null;        // raw Blob from MediaRecorder
let recorder      = null;        // AudioRecorder instance
let recTimerID    = null;        // setInterval handle for timer
let recSeconds    = 0;           // elapsed recording seconds
const audioURLs   = new Map();   // entry.id → ObjectURL (lazy)
const eventsCache = new Map();   // event.id → event object (for edit handler)
let   eventsCount = 0;           // kept in sync by renderEventsTimeline

// ── Boot ───────────────────────────────────────────────
async function init() {
  await loadEntries();
  renderTimeline();
  setupViewTabs();
  setupTabs();
  setupRecorder();
  setupSubmit();
  setupEntryInteractions();
  setupEventsInteractions();
  startEmbedderWorker();
}

// ── DB ─────────────────────────────────────────────────
async function loadEntries() {
  entries = await getAllEntries();
  updateCountBadge();
}

// ── Embedder Worker ────────────────────────────────────
function startEmbedderWorker() {
  embedderWorker = new Worker(
    new URL('./embedder.worker.js', import.meta.url),
    { type: 'module' }
  );

  embedderWorker.onmessage = ({ data }) => {
    const { type, data: info, embedding, id, message } = data;

    if (type === 'progress') onModelProgress(info);
    if (type === 'loaded')   onModelLoaded();

    if (type === 'embedding') {
      const p = pendingEmbed.get(id);
      if (p) { p.resolve(embedding); pendingEmbed.delete(id); }
    }
    if (type === 'error') {
      const p = pendingEmbed.get(id);
      if (p) { p.reject(new Error(message || 'Embedding failed')); pendingEmbed.delete(id); }
    }
  };

  embedderWorker.postMessage({ type: 'load' });
}

function onModelProgress(info) {
  const fill   = $('model-progress');
  const label  = $('model-status-label');
  if (!fill || !label) return;

  if (info?.status === 'downloading') {
    const pct = Math.min(Math.round(info.progress ?? 0), 99);
    fill.style.width = `${pct}%`;
    label.textContent = `Downloading AI model… ${pct}%`;
  } else if (info?.status === 'loading') {
    fill.style.width = '92%';
    label.textContent = 'Loading model into memory…';
  } else if (info?.status === 'ready') {
    fill.style.width = '100%';
  }
}

function onModelLoaded() {
  embedderReady = true;

  // Fade out overlay
  const overlay = $('model-overlay');
  overlay.classList.add('hidden');

  // Update status badge
  const badge = $('model-status-badge');
  badge.className = 'status-badge ready';
  $('status-label-text').textContent = 'AI Ready';

  refreshSubmitBtn();
  showToast('AI model loaded — ready to capture memories!', 'success');
}

function getEmbedding(text, id) {
  return new Promise((resolve, reject) => {
    pendingEmbed.set(id, { resolve, reject });
    embedderWorker.postMessage({ type: 'embed', text, id });
  });
}


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
    $('record-label').textContent = 'Stop Recording';

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
  $('record-label').textContent = 'Start Recording';

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
  $('submit-btn').disabled = !embedderReady || (!hasText && !hasAudio);
}

async function handleSubmit() {
  const content = currentMode === 'text'
    ? $('thought-input').value.trim()
    : currentTranscript.trim();

  if (!content) return;

  // ── Loading state ──
  const btn   = $('submit-btn');
  const icon  = $('submit-icon');
  const label = $('submit-label');
  btn.disabled  = true;
  icon.textContent  = '⏳';
  label.textContent = 'Embedding…';

  try {
    const id        = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Get embedding
    const embedding = await getEmbedding(content, id);

    // 2. Store audio as DataURL (if any)
    let audioData    = null;
    let audioMimeType = null;
    if (audioBlob) {
      audioData     = await blobToDataURL(audioBlob);
      audioMimeType = audioBlob.type;
    }

    // 3. Build & save entry
    const entry = { id, timestamp, type: currentMode === 'audio' ? 'audio' : 'text',
                    content, embedding, audioData, audioMimeType };
    await saveEntry(entry);
    await loadEntries();

    // 4. Find similar (exclude self)
    label.textContent = 'Finding connections…';
    const similar = findSimilar(embedding, entries, { excludeId: id, threshold: 0.38, topN: 5 });

    // 5. Render
    renderRelated(similar);
    renderTimeline();

    // 6. Highlight new entry
    setTimeout(() => highlightEntry(id), 120);

    // 7. Reset input
    if (currentMode === 'text') {
      $('thought-input').value = '';
      $('char-count').textContent = '0 characters';
    } else {
      currentTranscript = '';
      audioBlob         = null;
      $('transcript-preview').classList.add('hidden');
      $('transcript-text').textContent = '';
    }

    showToast(similar.length > 0
      ? `Memory saved! Found ${similar.length} related ${similar.length === 1 ? 'memory' : 'memories'}.`
      : 'Memory saved!', 'success');

    // 8. Extract life events in the background (non-blocking)
    extractAndSaveEvents(id, content);

  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    icon.textContent  = '💾';
    label.textContent = 'Save Memory';
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

  for (const [dayLabel, dayEntries] of grouped) {
    const group = document.createElement('div');
    group.className = 'timeline-day-group';
    group.innerHTML = `<div class="timeline-day-label">${dayLabel}</div>`;

    const entriesWrap = document.createElement('div');
    entriesWrap.className = 'timeline-entries';
    dayEntries.forEach(e => entriesWrap.appendChild(buildEntryCard(e)));
    group.appendChild(entriesWrap);
    container.appendChild(group);
  }

  updateCountBadge();
}

function buildEntryCard(entry) {
  const card = document.createElement('article');
  card.className = `entry-card ${entry.type === 'audio' ? 'audio-entry' : ''}`;
  card.id = `entry-${entry.id}`;

  const time  = formatTime(entry.timestamp);
  const badge = entry.type === 'audio'
    ? '<span class="entry-type-badge entry-type-audio">🎙 Audio</span>'
    : '<span class="entry-type-badge entry-type-text">📝 Text</span>';

  let audioHTML = '';
  if (entry.audioData) {
    audioHTML = `
      <audio id="aud-${entry.id}" src="${entry.audioData}" preload="auto"></audio>
      <div class="audio-player" id="player-${entry.id}">
        <button class="audio-play-btn" data-audio-id="${entry.id}" aria-label="Play recording">▶</button>
        <div class="player-timeline">
          <span class="player-time" id="cur-${entry.id}">0:00</span>
          <div class="player-scrubber-wrap">
            <div class="scrubber-track">
              <div class="scrubber-fill" id="fill-${entry.id}"></div>
            </div>
            <input class="player-scrubber" id="scrub-${entry.id}"
              type="range" min="0" max="100" step="0.01" value="0"
              aria-label="Seek through recording" />
          </div>
          <span class="player-time" id="dur-${entry.id}">--:--</span>
        </div>
        <button class="player-speed-btn" data-speed-id="${entry.id}" aria-label="Playback speed">1×</button>
      </div>
    `;
  }

  const hasSummary = !!entry.summary;
  const summaryHTML = hasSummary
    ? `<div class="summary-box" id="sum-${entry.id}">${esc(entry.summary)}</div>`
    : `<div class="summary-box hidden" id="sum-${entry.id}"></div>`;

  card.innerHTML = `
    <div class="entry-meta">
      <span class="entry-time">${time}</span>
      ${badge}
      <button class="entry-delete-btn" data-delete-id="${entry.id}" aria-label="Delete memory" title="Delete memory">🗑</button>
    </div>
    <p class="entry-content" dir="auto">${esc(entry.content)}</p>
    ${audioHTML}
    <button class="summarize-btn ${hasSummary ? 'has-summary' : ''}" data-summarize-id="${entry.id}" aria-label="Summarize">
      ✦ ${hasSummary ? 'Summary' : 'Summarize'}
    </button>
    ${summaryHTML}
  `;

  // Wire audio player events directly after innerHTML is set
  if (entry.audioData) {
    const aud  = card.querySelector(`#aud-${entry.id}`);
    const scrub = card.querySelector(`#scrub-${entry.id}`);
    const fill  = card.querySelector(`#fill-${entry.id}`);
    const cur   = card.querySelector(`#cur-${entry.id}`);
    const dur   = card.querySelector(`#dur-${entry.id}`);

    function setFill(pct) {
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }

    function applyDuration() {
      if (isFinite(aud.duration) && aud.duration > 0) {
        dur.textContent = fmtSecs(aud.duration);
        scrub.max = aud.duration;
      }
    }

    // loadedmetadata + durationchange cover all browser/data-URL timing cases
    aud.addEventListener('loadedmetadata', applyDuration);
    aud.addEventListener('durationchange',  applyDuration);

    // If already parsed (data URL may load synchronously in some browsers)
    if (aud.readyState >= 1) applyDuration();
    // Fallback: force a load after the card hits the DOM
    setTimeout(() => { if (!isFinite(aud.duration) || aud.duration === 0) aud.load(); }, 0);

    aud.addEventListener('timeupdate', () => {
      cur.textContent = fmtSecs(aud.currentTime);
      if (aud.duration) {
        scrub.value = aud.currentTime;
        setFill((aud.currentTime / aud.duration) * 100);
      }
    });

    aud.addEventListener('ended', () => {
      const btn = card.querySelector(`[data-audio-id="${entry.id}"]`);
      if (btn) btn.textContent = '▶';
      scrub.value = 0;
      setFill(0);
      cur.textContent = '0:00';
    });

    scrub.addEventListener('input', () => {
      aud.currentTime = Number(scrub.value);
      if (aud.duration) setFill((Number(scrub.value) / aud.duration) * 100);
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
        document.querySelectorAll('[data-audio-id]').forEach(b => { b.textContent = '▶'; });
        aud.play();
        playBtn.textContent = '⏸';
        aud.onended = () => { playBtn.textContent = '▶'; };
      } else {
        aud.pause();
        playBtn.textContent = '▶';
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

  await deleteEntry(id);
  await deleteEventsByMemoryId(id);   // clean up extracted events too
  await loadEntries();
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

    // Cache in DB
    entry.summary = summary;
    await saveEntry(entry);

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
    for (const ev of events) {
      await saveEvent({
        id:            crypto.randomUUID(),
        memoryId,
        date:          ev.date,
        title:         ev.title,
        description:   ev.description,
        memorySnippet: content.slice(0, 100)
      });
    }
    if (events.length > 0) {
      showToast(`📅 ${events.length} life event${events.length > 1 ? 's' : ''} added to your timeline!`, 'info');
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
        <div class="event-date-badge">📅 ${dateStr}, ${year}</div>
        <div class="event-action-btns">
          <button class="event-edit-btn" data-edit-event="${ev.id}" aria-label="Edit event" title="Edit">✏️</button>
          <button class="event-delete-btn" data-delete-event="${ev.id}" aria-label="Delete event" title="Delete">🗑</button>
        </div>
      </div>
      <div class="event-title" dir="auto">${esc(ev.title)}</div>
      <p class="event-description" dir="auto">${esc(ev.description)}</p>
      <div class="event-source" data-source-memory="${ev.memoryId}" role="button" tabindex="0" title="Jump to memory">
        <span class="event-source-arrow">↗</span>
        <span>From memory:</span>
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
init().catch(console.error);
