import { MSG, STAGE, OPFS_PATHS, WORDS_PER_AUDIO_PART } from "../lib/constants.js";
import { extractPdfText } from "../lib/pdf-extract.js";
import { TextWindower, cleanWindow } from "../lib/gemini-clean.js";
import { synthesizeLongText } from "../lib/edge-tts.js";
import { stitchAndPurgeParts } from "../lib/audio-stitch.js";
import * as opfs from "../lib/opfs.js";

function report(stage, detail = {}) {
  chrome.runtime.sendMessage({ type: MSG.PIPELINE_PROGRESS, stage, ...detail }).catch(() => {});
}

function reportError(message) {
  chrome.runtime.sendMessage({ type: MSG.PIPELINE_ERROR, message }).catch(() => {});
}

function reportComplete() {
  chrome.runtime.sendMessage({ type: MSG.PIPELINE_COMPLETE }).catch(() => {});
}

// Splits already-cleaned transcript text into ~targetWords-word parts,
// cutting only at paragraph breaks so no sentence is split across an
// audio file boundary.
function partitionByWords(text, targetWords) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    const slice = text.slice(start);
    const words = slice.split(/\s+/).filter(Boolean);
    if (words.length <= targetWords) {
      parts.push({ text: slice.trim(), startChar: start });
      break;
    }
    let count = 0;
    let cutLocal = -1;
    for (const match of slice.matchAll(/\S+/g)) {
      count++;
      if (count >= targetWords) {
        const breakIdx = slice.indexOf("\n\n", match.index + match[0].length);
        cutLocal = breakIdx === -1 ? slice.length : breakIdx + 2;
        break;
      }
    }
    if (cutLocal === -1) cutLocal = slice.length;
    parts.push({ text: slice.slice(0, cutLocal).trim(), startChar: start });
    start += cutLocal;
  }
  return parts.filter((p) => p.text.length > 0);
}

async function runPipeline({ apiKey, model, voice }) {
  await opfs.remove(OPFS_PATHS.CLEANED_TRANSCRIPT);
  await opfs.remove(OPFS_PATHS.TRANSCRIPT_MAP);
  await opfs.remove(OPFS_PATHS.FINAL_AUDIO);

  // --- Stage 1 + 2: streamed extraction -> strict Gemini cleaning ---
  report(STAGE.EXTRACTING, { page: 0, totalPages: 0 });
  const pdfFile = await opfs.readFile(OPFS_PATHS.SOURCE_PDF);
  const arrayBuffer = await pdfFile.arrayBuffer();

  const windower = new TextWindower({
    onWindow: async (windowText) => {
      const cleaned = await cleanWindow(apiKey, windowText, model);
      await opfs.appendFile(OPFS_PATHS.CLEANED_TRANSCRIPT, cleaned + "\n\n");
    },
  });

  await extractPdfText(arrayBuffer, async (pageNum, pageText, totalPages) => {
    report(STAGE.EXTRACTING, { page: pageNum, totalPages });
    await windower.push(pageText);
  });
  report(STAGE.CLEANING, { page: 1, totalPages: 1 });
  await windower.flush();

  // --- Stage 3: partition cleaned transcript into ~50-min parts, synthesize ---
  const cleanedTranscript = await opfs.readText(OPFS_PATHS.CLEANED_TRANSCRIPT);
  const parts = partitionByWords(cleanedTranscript, WORDS_PER_AUDIO_PART);

  const wordTimestamps = [];
  let timeBaseMs = 0;
  for (let i = 0; i < parts.length; i++) {
    report(STAGE.SYNTHESIZING, { part: i + 1, totalParts: parts.length });
    const { blob, wordTimestamps: localTimestamps, durationMs } = await synthesizeLongText(
      parts[i].text,
      voice,
      {
        onProgress: (chunk, totalChunks) => {
          report(STAGE.SYNTHESIZING, {
            part: i + 1,
            totalParts: parts.length,
            chunk,
            totalChunks,
          });
        },
      }
    );
    await opfs.writeStream(
      `${OPFS_PATHS.PARTS_DIR}/part_${String(i + 1).padStart(2, "0")}.mp3`,
      blob
    );
    for (const { charOffset, timeMs } of localTimestamps) {
      wordTimestamps.push({
        char: parts[i].startChar + charOffset,
        timeMs: timeBaseMs + timeMs,
      });
    }
    timeBaseMs += durationMs;
  }
  await opfs.writeJSON(OPFS_PATHS.TRANSCRIPT_MAP, wordTimestamps);

  // --- Stage 4: stitch parts, purge intermediates ---
  report(STAGE.STITCHING, {});
  await stitchAndPurgeParts();

  report(STAGE.READY, {});
  reportComplete();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.START_PIPELINE) {
    runPipeline(message).catch((err) => {
      console.error("Pipeline failed:", err);
      reportError(err.message || String(err));
    });
  }
});
