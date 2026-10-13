// Minimal client for the Microsoft Edge "Read Aloud" neural TTS WebSocket
// service. This is the same undocumented endpoint the Edge browser's
// built-in reader uses; there is no official public API for it, but the
// wire protocol is widely documented by open-source TTS tooling.
//
// One WebSocket round trip reliably handles a short-to-medium chunk of text;
// for a full ~50-minute audio part we split into sentence-respecting
// sub-chunks and synthesize them sequentially, concatenating the resulting
// MP3 byte streams (MP3 frames are independently decodable, so naive
// concatenation of whole files plays back correctly).

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const WS_ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const WORDS_PER_TTS_CHUNK = 100;

let clockSkewSeconds = 0;

/**
 * Syncs the local clock with Microsoft's server time from the Date header
 * to prevent clock-drift signature rejections.
 */
export async function syncServerClock() {
  try {
    const res = await fetch(
      `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
      { method: "HEAD", cache: "no-store" }
    );
    const dateStr = res.headers.get("Date");
    if (dateStr) {
      const serverTimeMs = new Date(dateStr).getTime();
      if (!Number.isNaN(serverTimeMs)) {
        clockSkewSeconds = Math.round((serverTimeMs - Date.now()) / 1000);
      }
    }
  } catch {
    // Non-fatal fallback to system clock
  }
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexUpper(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// DRM-style clock token the service started requiring: SHA-256 of the
// trusted client token appended to the current time (rounded down to the
// nearest 5 minutes), expressed as Windows file-time 100ns ticks.
async function generateSecMsGec() {
  // Windows filetime ticks (100ns units) for a present-day timestamp exceed
  // Number.MAX_SAFE_INTEGER, so this must be done in BigInt -- a plain
  // Number here silently loses precision and produces a signature the
  // server will reject.
  const WIN_EPOCH_OFFSET_SECONDS = 11644473600n;
  const currentUnixSec = BigInt(Math.floor(Date.now() / 1000) + clockSkewSeconds);
  let ticks = currentUnixSec + WIN_EPOCH_OFFSET_SECONDS;
  ticks -= ticks % 300n;
  const windowsTicks = ticks * 10_000_000n;
  return sha256HexUpper(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
}

function escapeSsml(text) {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoTimestamp() {
  return new Date().toString();
}

function buildSpeechConfigMessage() {
  return (
    `X-Timestamp:${isoTimestamp()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: "false",
              wordBoundaryEnabled: "true",
            },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    })
  );
}

// Ticks are 100ns units, as used throughout the Skype/Edge speech wire protocol.
const MS_PER_TICK = 1 / 10_000;

function parseWordBoundaries(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const items = data?.Metadata ?? [];
    return items
      .filter((m) => m.Type === "WordBoundary")
      .map((m) => ({
        word: m.Data?.text?.Text ?? "",
        offsetMs: (m.Data?.Offset ?? 0) * MS_PER_TICK,
        durationMs: (m.Data?.Duration ?? 0) * MS_PER_TICK,
      }));
  } catch {
    return [];
  }
}

function buildSsmlMessage(text, voice, requestId) {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-GB'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeSsml(text)}</prosody>` +
    `</voice></speak>`;
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${isoTimestamp()}\r\n` +
    `Path:ssml\r\n\r\n${ssml}`
  );
}

function parseBinaryAudioFrame(buffer) {
  const view = new DataView(buffer);
  const headerLength = view.getUint16(0);
  const headerBytes = new Uint8Array(buffer, 2, headerLength);
  const header = new TextDecoder().decode(headerBytes);
  if (!header.includes("Path:audio")) return null;
  return new Uint8Array(buffer, 2 + headerLength);
}

/**
 * Synthesizes one portion of text to an MP3 Blob.
 * Uses an inactivity timeout (reset on every received audio frame) so active
 * streams are never cut off prematurely.
 */
export function synthesizeChunk(text, voice) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      const secMsGec = await generateSecMsGec();
      const connectionId = randomHex(16);
      const url =
        `${WS_ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
        `&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}` +
        `&ConnectionId=${connectionId}`;
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      const audioParts = [];
      const wordBoundaries = [];
      let settled = false;

      // Inactivity timeout: triggers if server sends no data for 15 seconds
      let inactivityTimer = null;
      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.close();
          reject(new Error("Edge-TTS synthesis timed out (no data from server for 15s)"));
        }, 15_000);
      };

      // Hard ceiling timeout: 45s total max per chunk
      const hardCeiling = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        socket.close();
        reject(new Error("Edge-TTS synthesis timed out (chunk exceeded 45s)"));
      }, 45_000);

      resetInactivityTimer();

      socket.onopen = () => {
        socket.send(buildSpeechConfigMessage());
        socket.send(buildSsmlMessage(text, voice, randomHex(16)));
      };

      socket.onmessage = (event) => {
        resetInactivityTimer();
        if (typeof event.data === "string") {
          if (event.data.includes("Path:audio.metadata")) {
            const jsonStart = event.data.indexOf("\r\n\r\n") + 4;
            wordBoundaries.push(...parseWordBoundaries(event.data.slice(jsonStart)));
          } else if (event.data.includes("Path:turn.end")) {
            settled = true;
            if (inactivityTimer) clearTimeout(inactivityTimer);
            clearTimeout(hardCeiling);
            socket.close();
            resolve({ blob: new Blob(audioParts, { type: "audio/mpeg" }), wordBoundaries });
          }
          return;
        }
        const audio = parseBinaryAudioFrame(event.data);
        if (audio) audioParts.push(audio);
      };

      socket.onerror = () => {
        // The browser's WebSocket "error" event never carries a reason.
        // onclose fires right after with the actual close code.
      };

      socket.onclose = (event) => {
        if (settled) return;
        settled = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        clearTimeout(hardCeiling);
        let detail = `Edge-TTS WebSocket closed before completion (code ${event.code}`;
        if (event.reason) detail += `, reason: ${event.reason}`;
        if (event.code === 1006) {
          detail +=
            "). Microsoft rejected the connection handshake (HTTP 403 Forbidden). Ensure the extension is reloaded in chrome://extensions so declarativeNetRequest headers are active.";
        } else {
          detail += ")";
        }
        reject(new Error(detail));
      };
    } catch (err) {
      reject(err);
    }
  });
}

// Splits a text block into roughly equal halves at sentence/punctuation boundary
function splitTextIntoHalves(text) {
  const sentences = text.match(/[^.!?\n]+[.!?]?\s*/g) || [text];
  if (sentences.length <= 1) {
    const words = text.split(/\s+/).filter(Boolean);
    const mid = Math.max(1, Math.floor(words.length / 2));
    return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")].filter(Boolean);
  }
  const midSentence = Math.ceil(sentences.length / 2);
  const first = sentences.slice(0, midSentence).join("").trim();
  const second = sentences.slice(midSentence).join("").trim();
  return [first, second].filter(Boolean);
}

// Merges multiple TTS results into a single { blob, wordBoundaries }
function mergeTtsResults(results, subTexts) {
  const mergedParts = [];
  const mergedBoundaries = [];
  let cumulativeDurationMs = 0;

  for (let i = 0; i < results.length; i++) {
    const { blob, wordBoundaries } = results[i];
    mergedParts.push(blob);

    for (const boundary of wordBoundaries) {
      mergedBoundaries.push({
        word: boundary.word,
        offsetMs: boundary.offsetMs + cumulativeDurationMs,
        durationMs: boundary.durationMs,
      });
    }

    const last = wordBoundaries[wordBoundaries.length - 1];
    const subDurationMs = last
      ? last.offsetMs + last.durationMs
      : estimateDurationMs(subTexts[i] || "");
    cumulativeDurationMs += subDurationMs;
  }

  return {
    blob: new Blob(mergedParts, { type: "audio/mpeg" }),
    wordBoundaries: mergedBoundaries,
  };
}

/**
 * Synthesizes a chunk of text. If it times out or encounters a failure,
 * it automatically splits into smaller portions (down to sentences/words),
 * synthesizes each sub-portion, and merges all audio and word timings seamlessly.
 */
export async function synthesizeChunkAdaptive(text, voice) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { blob: new Blob([], { type: "audio/mpeg" }), wordBoundaries: [] };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);

  // If text is already very small (<= 25 words), try with direct retry
  if (words.length <= 25) {
    try {
      return await synthesizeChunk(trimmed, voice);
    } catch (err) {
      console.warn("Retrying small chunk...", err?.message || err);
      await syncServerClock();
      await new Promise((r) => setTimeout(r, 1000));
      return await synthesizeChunk(trimmed, voice);
    }
  }

  try {
    return await synthesizeChunk(trimmed, voice);
  } catch (err) {
    console.warn(
      `Portion synthesis timed out or failed (${words.length} words). Subdividing into smaller portions and merging audio...`,
      err?.message || err
    );

    const subChunks = splitTextIntoHalves(trimmed);
    if (subChunks.length <= 1) {
      // Cannot split further; retry once after clock sync
      await syncServerClock();
      await new Promise((r) => setTimeout(r, 1000));
      return await synthesizeChunk(trimmed, voice);
    }

    const results = [];
    for (const sub of subChunks) {
      if (!sub.trim()) continue;
      results.push(await synthesizeChunkAdaptive(sub.trim(), voice));
    }

    return mergeTtsResults(results, subChunks);
  }
}

// Splits text into sentence-respecting chunks of roughly WORDS_PER_TTS_CHUNK
// words each so no single WebSocket request gets too large.
function splitIntoTtsChunks(text, wordsPerChunk = WORDS_PER_TTS_CHUNK) {
  const sentences = text.match(/[^.!?\n]+[.!?]?\s*/g) || [text];
  const chunks = [];
  let current = "";
  let currentWords = 0;
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (currentWords + words > wordsPerChunk && current) {
      chunks.push(current.trim());
      current = "";
      currentWords = 0;
    }
    current += sentence;
    currentWords += words;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Matches each returned word against the source chunk text (starting from
// a moving cursor) to recover its character offset, so timing data can be
// tied back to specific positions in the transcript.
function locateWordOffsets(chunkText, wordBoundaries) {
  let cursor = 0;
  const located = [];
  for (const { word, offsetMs } of wordBoundaries) {
    if (!word) continue;
    const idx = chunkText.toLowerCase().indexOf(word.toLowerCase(), cursor);
    if (idx === -1) continue;
    located.push({ charOffset: idx, timeMs: offsetMs });
    cursor = idx + word.length;
  }
  return located;
}

/**
 * Synthesizes a full text part into one MP3 Blob, breaking into small
 * portions (~100 words) and adapting on timeout by sub-chunking and merging.
 *
 * Returns { blob, wordTimestamps, durationMs } where wordTimestamps are
 * [{ charOffset, timeMs }] with charOffset relative to the start of `text`
 * and timeMs relative to the start of this part's audio.
 */
export async function synthesizeLongText(text, voice, { onProgress } = {}) {
  await syncServerClock();
  const chunks = splitIntoTtsChunks(text, WORDS_PER_TTS_CHUNK);
  const blobs = [];
  const wordTimestamps = [];
  let charBase = 0;
  let timeBaseMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    const result = await synthesizeChunkAdaptive(chunks[i], voice);
    blobs.push(result.blob);

    const located = locateWordOffsets(chunks[i], result.wordBoundaries);
    for (const { charOffset, timeMs } of located) {
      wordTimestamps.push({ charOffset: charBase + charOffset, timeMs: timeBaseMs + timeMs });
    }

    const last = result.wordBoundaries[result.wordBoundaries.length - 1];
    const chunkDurationMs = last ? last.offsetMs + last.durationMs : estimateDurationMs(chunks[i]);
    timeBaseMs += chunkDurationMs;
    charBase += chunks[i].length;

    if (onProgress) onProgress(i + 1, chunks.length);
  }

  return { blob: new Blob(blobs, { type: "audio/mpeg" }), wordTimestamps, durationMs: timeBaseMs };
}

function estimateDurationMs(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (words / 150) * 60_000; // ~150 wpm fallback estimate
}

