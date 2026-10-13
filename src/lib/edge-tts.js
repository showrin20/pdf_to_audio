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
const SEC_MS_GEC_VERSION = "1-130.0.2849.68";
const WS_ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const WORDS_PER_TTS_CHUNK = 700;

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
  const WIN_EPOCH_OFFSET_SECONDS = 11644473600;
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH_OFFSET_SECONDS;
  ticks -= ticks % 300;
  const windowsTicks = ticks * 10_000_000;
  return sha256HexUpper(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
}

function escapeSsml(text) {
  return text
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
 * Synthesizes one chunk of text (keep this under ~1000 words) to an MP3 Blob.
 * Resolves with { blob, wordBoundaries } where wordBoundaries are timings
 * relative to the start of this chunk's audio.
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
      const timeout = setTimeout(() => {
        reject(new Error("Edge-TTS synthesis timed out"));
        socket.close();
      }, 30_000);

      socket.onopen = () => {
        socket.send(buildSpeechConfigMessage());
        socket.send(buildSsmlMessage(text, voice, randomHex(16)));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          if (event.data.includes("Path:audio.metadata")) {
            const jsonStart = event.data.indexOf("\r\n\r\n") + 4;
            wordBoundaries.push(...parseWordBoundaries(event.data.slice(jsonStart)));
          } else if (event.data.includes("Path:turn.end")) {
            clearTimeout(timeout);
            socket.close();
            resolve({ blob: new Blob(audioParts, { type: "audio/mpeg" }), wordBoundaries });
          }
          return;
        }
        const audio = parseBinaryAudioFrame(event.data);
        if (audio) audioParts.push(audio);
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Edge-TTS WebSocket error"));
      };
    } catch (err) {
      reject(err);
    }
  });
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
 * Synthesizes a full ~50-minute text part into one MP3 Blob, chunking
 * internally to stay within safe per-request limits. Retries a chunk once
 * on transient WebSocket failure before giving up.
 *
 * Returns { blob, wordTimestamps, durationMs } where wordTimestamps are
 * [{ charOffset, timeMs }] with charOffset relative to the start of `text`
 * and timeMs relative to the start of this part's audio.
 */
export async function synthesizeLongText(text, voice, { onProgress } = {}) {
  const chunks = splitIntoTtsChunks(text);
  const blobs = [];
  const wordTimestamps = [];
  let charBase = 0;
  let timeBaseMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    let result;
    try {
      result = await synthesizeChunk(chunks[i], voice);
    } catch {
      result = await synthesizeChunk(chunks[i], voice); // one retry
    }
    blobs.push(result.blob);

    const located = locateWordOffsets(chunks[i], result.wordBoundaries);
    for (const { charOffset, timeMs } of located) {
      wordTimestamps.push({ charOffset: charBase + charOffset, timeMs: timeBaseMs + timeMs });
    }

    const last = result.wordBoundaries[result.wordBoundaries.length - 1];
    const chunkDurationMs = last ? last.offsetMs + last.durationMs : estimateDurationMs(chunks[i]);
    timeBaseMs += chunkDurationMs;
    charBase += chunks[i].length;
    // Account for the separator re-inserted between chunks by the caller's
    // joining of `text`; chunks are produced by splitIntoTtsChunks which
    // keeps original whitespace, so no extra offset is needed here.

    if (onProgress) onProgress(i + 1, chunks.length);
  }

  return { blob: new Blob(blobs, { type: "audio/mpeg" }), wordTimestamps, durationMs: timeBaseMs };
}

function estimateDurationMs(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (words / 150) * 60_000; // ~150 wpm fallback estimate
}
