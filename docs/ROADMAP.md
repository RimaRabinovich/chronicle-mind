# Chronicle Mind — Architecture & Roadmap Plan

## Context
Chronicle Mind (Vite + vanilla JS, Firebase Google auth, Supabase edge functions + pgvector, Groq Whisper/Llama) lets the user write, record, or import text/audio/video "memories", extracts life events, and shows a timeline. Goals going forward:
1. Turn input into **insights**: recurring topics ("you keep talking about X"), wishes vs. actual behavior ("you do Y but said you want Z"), and a tracked list of wishes/goals.
2. Build a **time-ordered timeline** from the data itself (when something happened, not only when it was saved).
3. **Privacy**: the user owns their data. Decision: **local-first, encrypted in the browser, with optional encrypted backup to the user's own Google Drive. Our servers store nothing.**
4. **Long audio/video**: compress, chunk, transcribe, and summarize reliably.
5. **Cheapest AI**: decision: **Groq behind a thin, stateless proxy** (free tier, about $0.04 per audio hour on paid).
6. Fix the broken **Summarize** button.

Problems in the current code:
- `src/main.js:1390` `handleSummarize` does `sumBox.textContent = summary`. That wipes the `.summary-text` span and the undo button created in `buildEntryCard` (`main.js:1069-1102`), and it never hides the `+ Summary` button. The media flow (`main.js:744-752`) does this correctly.
- `VITE_GROQ_API_KEY` is shipped in the browser bundle (`main.js:272`, `ai.js`, `transcription.js`), so anyone can extract it.
- Media is sent raw to Groq Whisper, which has a 25 MB per-request limit, so long files fail. Original files are uploaded in plaintext to Supabase Storage.
- Embeddings: `src/embedder.worker.js` uses `all-MiniLM-L6-v2`, which is English-only (the user writes in Hebrew). The server uses `gte-small`, and a mock hash fallback silently produces garbage vectors.
- `extractEvents` parses JSON with regex salvage. JSON mode would be more reliable.

---

## Status (2026-10-12)
- **Phase 0: DONE** (commit `2cca796`, which also switched the retired Groq Llama models to `gpt-oss`; the Llama model names in Phase 4 are out of date).
- **Phase 1: DONE.** `ai-proxy` is deployed with `--no-verify-jwt` and the app works through it. The old Groq key has been rotated and `VITE_GROQ_API_KEY` removed from `.env`. Also added a spoken-language picker (Auto/Hebrew/English) for Whisper.
- **Phase 2: DONE (tested in the app with an MP4 import).** Added `src/media/compress.js` (ffmpeg.wasm turns any audio or video into mono 16 kHz Opus at 32 kbps (raised from 16 kbps/voip after the first test dropped sentences) and splits it into 600 s chunks with a segment list) and `src/media/transcribePipeline.js`, which transcribes the chunks in order, passing the end of the previous chunk as the prompt, with retry and backoff and stitched `verbose_json` segments. Import now uploads only the compressed audio and saves `metadata.transcript_segments`. Recorder bitrate is 24 kbps. Video entries get the audio player. The build passes, and the ffmpeg arguments were checked with native ffmpeg.
  - Changes from the plan: kept `whisper-large-v3` (Hebrew quality) instead of turbo; chunks run one at a time (each needs the previous chunk's text as its prompt); no separate `compress.worker.js` (ffmpeg.wasm runs in its own worker).
  - Imports now save `metadata.captured_at` (the media's embedded `creation_time` via ffmpeg, else the file's last-modified date), and the memories list is sorted by it (falls back to `created_at`). This is the client-side start of Phase 4's `captured_at`; no DB migration yet.
  - Resume after refresh: `src/media/jobStore.js` keeps each import's job in IndexedDB (`chronicle-mind-jobs-<uid>`): compressed chunks, per-chunk transcripts, upload path, then the transcript until the summary is saved. On load, `resumeMediaJobs` continues from the next step; Web Locks stop two tabs from running the same job. A refresh *during compression* can't resume (the original file isn't stored), so the placeholder is removed and the user is asked to re-import. A failed job after compression is kept and retried on the next load. Tested in the app with an 86-min file.
  - Long transcripts: Groq's free tier allows 8,000 tokens per minute (TPM) per model, and an 86-minute transcript (~15k tokens) got a 413 on summarize. `src/ai.js` now splits texts over 8,000 chars into parts: summarize goes part by part and then combines the part summaries, and extractEvents runs per part (2,048 max_tokens) and de-duplicates the results. `groqChat` waits for Groq's "try again in Xs" on a 429 and retries (up to 6 tries). This is a stopgap; Phase 4's per-chunk structured extraction replaces it.
  - Groq free-tier limits: Whisper allows 7,200 audio-seconds per hour (about 2 h of audio per hour), so one 86-min file plus a retry runs past it. A 429 now waits as long as Groq says ("try again in 3m36s"), up to 10 times, and the card shows when it will continue. Imports run one at a time per tab (`queueMediaJob`). Deleting a card aborts its import (AbortController), deletes the job, and removes any audio already uploaded. The upload path is saved to the memory as soon as the upload finishes, and a resumed card plays the compressed audio kept in the job. If a chat reply is cut off (`finish_reason: length`), it is retried with double `max_tokens`; summaries now start at 1,200.
  - Storage paths are now ASCII-only (`uploadFile` sanitizes the name). A Hebrew file name broke the `X-File-Path` header. The real name stays in `metadata.file_name`.
  - `embed` ran out of compute (546) on long transcripts because it embedded all chunks in parallel. It now embeds them one at a time and accepts `chunk_offset`, and `triggerEmbedding` sends 4,000-char batches. Needs `supabase functions deploy embed --no-verify-jwt`. Phase 4 moves embeddings into the browser anyway.
  - Still to do: an optional "keep original" setting.
  - Hosting note: Cloudflare Pages has a 25 MB per-file limit, smaller than the 32 MB wasm file; Vercel and Netlify are fine.

- **Phase 3: DONE (tested in the app).**
  - `src/crypto.js`: random 256-bit DEK, wrapped by a PBKDF2-SHA256 (600k) key from the passphrase. Records use AES-GCM with the label `"<store>:<id>"` as additional data, so ciphertexts can't be swapped between records. The recovery key is the DEK in Crockford base32 (13 groups of 4). A check value lets the app verify a recovery key.
  - `src/store/`: `db.js` (IndexedDB `chronicle-vault-<uid>`, rows `{id, ts?, iv, ct}`), `vault.js` (create/unlock/recover/remember device), `memories.js` and `events.js` (same functions as `services/`), `media.js` (encrypted audio in 1 MB parts, referenced as `file_url = "media:<id>"`), and `migrateFromCloud.js`.
  - `src/vaultScreen.js` with markup in `index.html`: after Google sign-in, either create a passphrase (then show the recovery key once, with copy/download and an "I saved it" checkbox) or unlock, or recover with the key and set a new passphrase. "Stay unlocked on this device" stores the non-extractable key in IndexedDB. Lock, Sign out and Delete account forget it and reload the page.
  - Media imports and recordings now store audio encrypted locally instead of uploading it. The job store moved into the vault (encrypted, with chunk audio in the media store). The old plaintext `chronicle-mind-jobs-<uid>` database is deleted on load. Server embeddings (`triggerEmbedding`) are no longer called; Phase 4 adds local ones.
  - Migration: if the cloud still has data, a banner offers "Move to this device". It copies memories (keeping their ids), events and audio, verifies every id locally, and then offers "Delete cloud copy" as a separate, confirmed step. `deleteUserFolder` now deletes every folder (it used to skip `video/` and anything past 100 files) and fails loudly instead of silently.
  - Deviation from the plan: media lives in IndexedDB, not OPFS. Safari's OPFS write support is patchy, and IndexedDB stores the encrypted bytes fine.
  - Tested in Node (WebCrypto plus fake-indexeddb): vault create/unlock/wrong passphrase/recover, records holding only id/ts/iv/ct, media round trip, jobs, and migration with stubbed Supabase.
  - After the user verifies the migration: retire the `memories`, `events`, `embed`, `rag-query` and `upload` edge functions and drop the tables (manual).

## Phase 0: Fix Summarize (small, do first) [DONE]
- In `handleSummarize` (`src/main.js:1366`), mirror the media path: set `sumBox.querySelector('.summary-text').textContent`, remove `hidden` from the box, and add `hidden` to the button. On error, restore the label to `+ Summary`.
- Remove the dead "toggle if already has summary" branch (the button is hidden when a summary exists), or keep it consistent.

## Phase 1: Stateless AI proxy (remove the key from the browser)
- New edge function `supabase/functions/ai-proxy/index.ts`. Reuse `_shared/firebase-verify.ts` and `_shared/cors.ts`. Routes: `POST /transcribe` (multipart passthrough to Groq `audio/transcriptions`) and `POST /chat` (passthrough to `chat/completions`, with an allowlist of models and a max_tokens cap).
- It **does not log or store bodies**. Add a simple per-uid rate limit (in-memory or a small counter table that stores only counts).
- `GROQ_API_KEY` becomes a Supabase secret only. Delete `VITE_GROQ_API_KEY` from `.env.example`. Change `groqChat` in `src/ai.js` and `transcribeAudio` in `src/transcription.js` to call `callEdgeFn` (`src/services/api.js`). Note: `callEdgeFn` JSON-encodes the body, so add a small multipart variant for audio.
- Note for users: content passes through Groq transiently (Groq does not train on API data). This is the one privacy trade-off. Swapping in a local whisper.cpp/Ollama later only means changing the proxy target.

## Phase 2: Media pipeline (compress → chunk → transcribe), all in the browser
This is the common industry approach: extract audio only, downmix to mono, resample to 16 kHz, encode as low-bitrate Opus, and split into overlapping chunks.
- Add `@ffmpeg/ffmpeg` (ffmpeg.wasm, run in a Worker; mount the input via WORKERFS so a 2-hour video is never fully loaded into memory). New `src/media/compress.worker.js`:
  `ffmpeg -i in -vn -ac 1 -ar 16000 -c:a libopus -b:a 16k -f segment -segment_time 600 out%03d.ogg`
  At 16 kbps Opus, one hour is about 7 MB (a 1-hour phone video is usually 500 MB to 1 GB). Whisper accuracy is effectively unchanged at 16 kHz mono.
- New `src/media/transcribePipeline.js`: send chunks to `/transcribe` with concurrency 2–3, retry with backoff, model `whisper-large-v3-turbo` (cheapest; keep `whisper-large-v3` as an option for hard Hebrew audio), `response_format=verbose_json` to get **segment timestamps**. Pass the previous chunk's last sentence as `prompt` for continuity. Stitch segments with offsets applied.
- Show progress per stage (compressing, transcribing x/N, analyzing) in the existing `import-processing-indicator`. Persist a job record so a refresh can resume unfinished chunks.
- **Storage of media**: keep only the compressed Opus audio (and the transcript). The original video is not kept by default; the user still has it on their device or Drive. Optional setting: "keep original."
- Recording (`src/recorder.js`): set `MediaRecorder` to `audio/webm;codecs=opus` with `audioBitsPerSecond: 24000` so recordings are already small.
- The same pipeline replaces `main.js:695-774` background processing.

## Phase 3: Local-first encrypted storage (replace Supabase data tables)
- **Storage engine**: IndexedDB via the existing `src/db.js` (`idb`, user-scoped DB name). Bump `DB_VERSION` and add stores: `entries`, `events`, `chunks` (text + embedding), `extractions`, `wishes`, `insights`, `jobs`. Store media blobs in **OPFS** (`navigator.storage.getDirectory()`), referenced by id. Call `navigator.storage.persist()` to prevent eviction.
- **Encryption** (new `src/crypto.js`, WebCrypto only):
  - On first run the user sets a passphrase. Derive a KEK with PBKDF2-SHA256 (600k iterations) or Argon2id via `hash-wasm`. Generate a random 256-bit **data key (DEK)**, wrap it with the KEK, and store the wrapped DEK + salt.
  - Each record is stored as `{id, timestamp, iv, ciphertext}` with AES-GCM, using a fresh 96-bit IV per write. Only `id` and the timestamp index stay in plaintext, for ordering. Media blobs are encrypted the same way, in 1 MB chunks.
  - After unlock, keep the unwrapped DEK as a **non-extractable** `CryptoKey` in memory, with an optional "remember on this device" (store the non-extractable key in IndexedDB).
  - Show a **recovery key** once (the DEK exported as words or base64) and warn clearly: lose the passphrase and the recovery key, and the data is gone. That is the cost of "only you can read it."
- **Data layer**: new `src/store/` (`entries.js`, `events.js`, …) with the same function signatures as `src/services/memories.js` / `events.js`, so `main.js` call sites change minimally (`saveMemory`, `getAllMemories`, `updateMemory`, `deleteMemory`, …).
- **Migration**: one-time "Move my data to this device" using the existing `src/services/migration.js` pattern: download from Supabase, encrypt locally, verify the count, then call `deleteAllUserMemories()` and `deleteUserFolder()` (`src/services/storage.js`). After that, retire the `memories`, `events`, `embed`, `rag-query`, and `upload` edge functions and the tables. Supabase remains only for `ai-proxy` (and Firebase stays for auth and the Drive token).

## Phase 4: Understanding the data (structured extraction + local embeddings)
- **Per-chunk structured extraction** (map step). For each ~1.5k-token transcript or text chunk, make one `/chat` call with `response_format: {type:"json_object"}` (this removes `salvageEvents` regex). Schema:
  ```json
  { "summary": "...", "topics": ["..."], "people": ["..."],
    "events":  [{"date":"YYYY-MM-DD","precision":"day|month|year|approx","title":"...","quote":"..."}],
    "wishes":  [{"text":"I want to ...","strength":1-3,"quote":"..."}],
    "actions": [{"text":"I did/do ...","habitual":true,"quote":"..."}],
    "emotions":[{"label":"...","intensity":1-3}] }
  ```
  **Reduce step** for long media: merge the chunk summaries into the entry summary (this replaces `summarizeContent`). Keep `llama-3.3-70b-versatile` for Hebrew quality; try a cheaper model on the map step once there are test samples.
- **Timeline / time order**: every entry has `captured_at` (from the recording time, `File.lastModified`, or `creation_time` in the media metadata read by ffmpeg) plus extracted `events[].date` with `precision`. The Events tab sorts by event date and shows precision ("~2011"). Within one recording, segment timestamps let each event or quote jump to the moment in the audio (the waveform player already exists).
- **Embeddings in the browser**: keep `src/embedder.worker.js`, but switch to a multilingual model, `Xenova/multilingual-e5-small` (384-dim, Hebrew-capable). Embed chunks, topics, wishes, and actions locally and store them encrypted in IndexedDB. Similarity uses the existing `findSimilar`/`cosineSimilarity` in `src/embeddings.js` (brute force is fine up to tens of thousands of vectors). This replaces server pgvector, RAG retrieval runs locally, and only the top-k snippets go to `/chat` for answers.

## Phase 5: Insights & wish tracking
All aggregation is client-side over the decrypted `extractions`, so it is cheap and private.
- **Recurring topics**: cluster topic labels by embedding (cosine > ~0.8 merges "mom" / "אמא" / "my mother"), then count mentions per cluster over rolling windows (30/90 days). Card: "You've mentioned **X** in 9 entries over the last month (up from 2)", linking to those entries.
- **Wish tracker**: deduplicate wishes by embedding into a `wishes` store with `{text, first_said, last_said, times_mentioned, status: open|in-progress|done|dropped, linked_actions[]}`. The user can edit or confirm. Link actions to wishes by similarity.
- **Gaps / contradictions**: a wish mentioned ≥ N times with no linked action in M weeks gives "You've said you want **Z** 5 times since March, but nothing about doing it." Habitual actions that semantically oppose a wish (detected by an LLM judge over a compact digest of wish/action pairs, not raw text) give "You do **Y**, but you said you want **Z**."
- **Weekly reflection**: a button (later automatic on open, at most once a week) sends a compact digest (topic counts, open wishes, recent actions; no raw entries) to `/chat` and stores the result in `insights`.
- UI: a new "Insights" view tab next to Memories / Life Events (`setupViewTabs`, `main.js:279`).

## Phase 6: Encrypted Google Drive backup / multi-device
- Reuse the Drive token flow (`src/services/googleDrive.js`, `src/auth.js`) and request the `drive.appdata` scope (a hidden app folder the user owns and can delete; not a restricted scope).
- Upload already-encrypted records and media as files (`manifest.json` with ids and `updated_at`, plus one blob per record). Sync = compare the manifest and push or pull newer items; last-write-wins per record. A new device restores with the passphrase or recovery key.
- Also offer "Export everything" (an encrypted `.zip`) and "Delete everything".
- Also fix the existing "Import from Drive" for media (`main.js:716` says it is not working): the downloaded blob simply goes into the Phase 2 pipeline.

## Cost summary
| Piece | Cost |
|---|---|
| Hosting (Vite static build on Vercel/Netlify/Cloudflare Pages) | free |
| Supabase (only `ai-proxy` edge function) | free tier |
| Groq Whisper turbo | free tier with rate limits; paid ≈ $0.04 / audio hour |
| Groq LLM extraction | free tier; paid is cents per hour of transcript |
| Embeddings, storage, insights | in-browser, free |
| Drive backup | the user's own quota |

## Suggested order
0 → 1 → 2 → 3 → 4 → 5 → 6. Phases 0–2 are fast wins on the current Supabase setup. Phase 3 is the big switch. Phases 4–5 are the product value.

## Critical files
- Modify: `src/main.js` (handleSubmit media flow, handleSummarize, view tabs), `src/ai.js`, `src/transcription.js`, `src/recorder.js`, `src/db.js`, `src/embedder.worker.js`, `src/services/api.js`, `src/services/googleDrive.js`, `.env.example`, `package.json`
- New: `supabase/functions/ai-proxy/`, `src/crypto.js`, `src/media/compress.worker.js`, `src/media/transcribePipeline.js`, `src/store/*`, `src/insights/*`
- Retire after migration: `supabase/functions/{memories,events,embed,rag-query,upload}`, `src/services/{memories,events,storage,rag}.js`

## Verification
- Phase 0: `npm run dev`. Create a text memory, click "+ Summary": the summary appears inside the box, the undo button works, and the button hides and reappears on undo.
- Phase 1: `grep -r GROQ dist/` after `npm run build` returns nothing. Transcription and summary still work. A request without a Firebase token gets 401 from `ai-proxy`.
- Phase 2: import a ≥ 1-hour MP4 (> 25 MB). Check the compressed size (about 7 MB/hour), that N chunks are transcribed, that the stitched transcript has correct timestamps, and that refresh mid-job resumes.
- Phase 3: in DevTools → Application → IndexedDB, records are ciphertext only. Lock, then unlock with the passphrase, and the data returns. The wrong passphrase fails. The recovery key restores. The Supabase tables are empty after migration.
- Phase 4–5: seed about 20 Hebrew/English entries that repeat a topic and a wish with no action. Check that the Insights tab shows the recurring-topic and wish-gap cards and that the events timeline is ordered by event date.
- Phase 6: back up on browser A, restore on browser B (or a fresh profile) with the passphrase, and confirm the entry count and media playback match.
