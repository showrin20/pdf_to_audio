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
const SEC_MS_GEC_VERSION = "2-143.0.3650.75";
const WS_ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const WORDS_PER_TTS_CHUNK = 100;

let clockSkewSeconds = 0;
let clockSyncDone = false;

/**
 * Syncs the local clock with Microsoft's server time from the Date header
 * to prevent clock-drift signature rejections.
 */
export async function syncServerClock() {
  if (clockSyncDone) return;
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
        clockSyncDone = true;
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

// --- Sec-MS-GEC v2 Token Generator ---
const WIN_EPOCH = 11644473600n;

const _SHA256_INITIAL = new Uint32Array([
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
]);
const _SHA256_STATE = new Uint32Array([
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
]);
const _SHA256_SCHEDULE = new Uint32Array([
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
]);
const _SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
  0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
  0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
  0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
  0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
  0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
]);
const _SHA256_BLOCK_CONSTANTS = new Uint32Array(_SHA256_ROUND_CONSTANTS);
_SHA256_BLOCK_CONSTANTS[14] = 0xC9DC06A7;

const _CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];

function _rol16(v) { return (((v << 16) | (v >>> 16)) >>> 0); }
function _rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
function _words_le4_even(data) {
  const padLen = (-data.length) & 3;
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(view.getUint32(i, true));
  if (words.length % 2 !== 0) words.push(0);
  return words;
}
function _sigma0(v) { return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0; }
function _sigma1(v) { return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0; }

function _sha256_rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = (_rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)) >>> 0;
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = (h + s1 + ch + constants[i] + words[i]) >>> 0;
    const s0 = (_rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = (s0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function _expand_sha256_schedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words.push((_sigma1(words[i - 2]) + words[i - 7] + _sigma0(words[i - 15]) + words[i - 16]) >>> 0);
  }
}

function _sha256_init(data) {
  const words = new Array(14).fill(0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  words.push((data[0] << 16) | (data[1] << 8) | data[2]);
  words.push(view.getUint32(3, false));
  for (let i = 16; i < 30; i++) {
    let val = _SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) val = (val + (i === 16 ? (_sigma1(words[i - 2]) ^ 0x000B92C0) : _sigma1(words[i - 2]))) >>> 0;
    if (i - 7 >= 14) val = (val + words[i - 7]) >>> 0;
    if (i - 15 >= 14) val = (val + (i === 29 ? (_sigma0(words[i - 15]) ^ 0x059C0B80) : _sigma0(words[i - 15]))) >>> 0;
    words.push(val >>> 0);
  }
  words.push((_sigma1(words[28]) + words[23] + _sigma0(words[15]) + words[14] + 0xC9DC06A7 - _SHA256_ROUND_CONSTANTS[14]) >>> 0);
  _expand_sha256_schedule(words, 31);
  const working = _sha256_rounds(Array.from(_SHA256_STATE), words, 14);
  return _SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function _sha256_digest(data) {
  const length = 57 + data.length;
  const padLength = (55 - length) % 64;
  const padCount = padLength < 0 ? padLength + 64 : padLength;
  const padded = new Uint8Array((data.length - 7) + 1 + padCount + 8);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(length) * 8n, false);
  let state = _sha256_init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let j = 0; j < 64; j += 4) words.push(view.getUint32(offset + j, false));
    _expand_sha256_schedule(words, 16);
    const working = _sha256_rounds(state, words, 0);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i], false);
  return out;
}

function _cs64_digest(data, digest) {
  const dView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const key_a = dView.getUint32(0, true) | 1;
  const key_b = dView.getUint32(4, true) | 1;
  const factors = [Math.imul(key_a, 0x82893933) >>> 0, Math.imul(key_b, 0x82893933) >>> 0];
  const terms = _CS64_COEFFICIENTS.map(([c], idx) => Math.imul(c, factors[idx % 2]) >>> 0);
  const offsets = _CS64_COEFFICIENTS.map(([, o]) => o >>> 0);
  const inputWithZero = new Uint8Array(1 + data.length);
  inputWithZero.set(data, 1);
  const words = _words_le4_even(inputWithZero);
  words.forEach((word, index) => {
    let term = Math.imul(word, index % 2 === 0 ? key_a : key_b) >>> 0;
    let offset = Math.imul(_rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0;
    if (index === 0) {
      term = (term + Math.imul(0xF2F90B1A, factors[0])) >>> 0;
      offset = (offset + 0x0B1A0000) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swap_acc = 0, swap_last = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = _rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swap_acc = (swap_acc + Math.imul(_rol16(q), 0xC3EFEA97) + q) >>> 0;
    t = _rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swap_last = (Math.imul(_rol16(q), 0x35BD1EC9) + q) >>> 0;
    swap_acc = (swap_acc + swap_last) >>> 0;

    state = (Math.imul(state, key_a) + x) >>> 0;
    state = Math.imul(_rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(_rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(_rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(_rol16(state), 0x257E1D83) >>> 0;
    acc = (acc + state) >>> 0;
    t = (Math.imul(state, key_b) + y) >>> 0;
    t = Math.imul(_rol16(t), 0xA27416F5) >>> 0;
    t = Math.imul(_rol16(t), 0xD38396FF) >>> 0;
    state = Math.imul(_rol16(Math.imul(_rol16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [(swap_last ^ state) >>> 0, (swap_acc ^ acc) >>> 0];
}

/**
 * Generates the Sec-MS-GEC v2 token (CS64 + adjusted SHA-256) matching Microsoft
 * Edge's current read-aloud protocol requirement.
 */
export function generateSecMsGec() {
  const currentUnixSec = BigInt(Math.floor(Date.now() / 1000) + clockSkewSeconds);
  let ticks = currentUnixSec + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10_000_000n;
  const strToHash = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = _sha256_digest(strToHash);
  const [csWord0, csWord1] = _cs64_digest(strToHash, digest);
  const csBuf = new Uint8Array(8);
  const csView = new DataView(csBuf.buffer);
  csView.setUint32(0, csWord0, true);
  csView.setUint32(4, csWord1, true);

  const csHex = Array.from(csBuf).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const shaHex = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${csHex}-${shaHex}`;
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
      await syncServerClock();
      const secMsGec = generateSecMsGec();
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
export function locateWordOffsets(chunkText, wordBoundaries) {
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
 * Synthesizes a single portion of text (~150-200 words).
 * Returns { blob, wordTimestamps, durationMs } where wordTimestamps are
 * [{ charOffset, timeMs }] relative to this portion.
 */
export async function synthesizePortion(text, voice) {
  await syncServerClock();
  const result = await synthesizeChunkAdaptive(text, voice);
  const wordTimestamps = locateWordOffsets(text, result.wordBoundaries);
  const last = result.wordBoundaries[result.wordBoundaries.length - 1];
  const durationMs = last
    ? last.offsetMs + last.durationMs
    : estimateDurationMs(text);

  return {
    blob: result.blob,
    wordTimestamps,
    durationMs,
  };
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

export function estimateDurationMs(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (words / 150) * 60_000; // ~150 wpm fallback estimate
}

