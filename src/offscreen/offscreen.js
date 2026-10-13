import {
  MSG,
  STAGE,
  OPFS_PATHS,
  WORDS_PER_AUDIO_PORTION,
  TTS_PORTION_DELAY_MS,
  GEMINI_REQUEST_DELAY_MS,
  WORDS_PER_CLEAN_WINDOW,
} from "../lib/constants.js";
import { extractPdfText } from "../lib/pdf-extract.js";
import { cleanWindow, partitionTextIntoWindows, sleep } from "../lib/gemini-clean.js";
import { synthesizePortion } from "../lib/edge-tts.js";
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

/**
 * Splits already-cleaned transcript text into smaller portions (~targetWords each, e.g. ~180 words),
 * respecting paragraph breaks and sentence breaks so no sentence is split across an audio boundary.
 * Records exact startChar in the source transcript for click-to-seek and highlighting.
 */
function partitionIntoPortions(text, targetWords = WORDS_PER_AUDIO_PORTION) {
  const portions = [];
  let cursor = 0;

  function splitLongBlock(block, blockStartChar) {
    const sentences = block.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+$/g) || [block];
    let currentText = "";
    let currentStart = blockStartChar;
    let currentWords = 0;

    for (const sent of sentences) {
      const words = sent.split(/\s+/).filter(Boolean).length;
      if (currentWords + words > targetWords && currentText.trim()) {
        portions.push({
          text: currentText.trim(),
          startChar: currentStart,
        });
        currentStart += currentText.length;
        currentText = "";
        currentWords = 0;
      }
      currentText += sent;
      currentWords += words;
    }
    if (currentText.trim()) {
      portions.push({
        text: currentText.trim(),
        startChar: currentStart,
      });
    }
  }

  const paragraphs = text.split(/\n{2,}/);
  let currentPortion = "";
  let portionStart = 0;
  let portionWords = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const paraStart = text.indexOf(trimmed, cursor);
    cursor = paraStart + trimmed.length;
    const words = trimmed.split(/\s+/).filter(Boolean).length;

    if (words > targetWords * 1.5) {
      if (currentPortion.trim()) {
        portions.push({
          text: currentPortion.trim(),
          startChar: portionStart,
        });
        currentPortion = "";
        portionWords = 0;
      }
      splitLongBlock(trimmed, paraStart);
      continue;
    }

    if (portionWords + words > targetWords && currentPortion.trim()) {
      portions.push({
        text: currentPortion.trim(),
        startChar: portionStart,
      });
      currentPortion = "";
      portionWords = 0;
    }

    if (!currentPortion) {
      portionStart = paraStart;
    } else {
      currentPortion += "\n\n";
    }
    currentPortion += trimmed;
    portionWords += words;
  }

  if (currentPortion.trim()) {
    portions.push({
      text: currentPortion.trim(),
      startChar: portionStart,
    });
  }

  return portions.filter((p) => p.text.length > 0);
}

async function runPipeline({ apiKey, model, voice }) {
  // Wipe all existing pipeline files before starting fresh
  await opfs.remove(OPFS_PATHS.CLEANED_TRANSCRIPT);
  await opfs.remove(OPFS_PATHS.TRANSCRIPT_MAP);
  await opfs.remove(OPFS_PATHS.FINAL_AUDIO);
  await opfs.remove(OPFS_PATHS.PARTS_DIR, { recursive: true });

  // --- Stage 1: Streamed extraction from Page 1 to the end ---
  report(STAGE.EXTRACTING, { page: 0, totalPages: 0 });
  const pdfFile = await opfs.readFile(OPFS_PATHS.SOURCE_PDF);
  const arrayBuffer = await pdfFile.arrayBuffer();

  const rawPages = [];
  await extractPdfText(arrayBuffer, async (pageNum, pageText, totalPages) => {
    report(STAGE.EXTRACTING, { page: pageNum, totalPages });
    rawPages.push(pageText);
  });

  const fullRawText = rawPages.filter(Boolean).join("\n\n").trim();
  if (!fullRawText) {
    throw new Error(
      "No readable text found in this PDF. It may be a scanned image or empty. Please use a PDF with digital text."
    );
  }

  // --- Stage 2: Clean and organize text in windows with pacing ---
  const windows = partitionTextIntoWindows(fullRawText, WORDS_PER_CLEAN_WINDOW);
  const totalWindows = windows.length;
  report(STAGE.CLEANING, { window: 1, totalWindows });

  for (let w = 0; w < totalWindows; w++) {
    report(STAGE.CLEANING, { window: w + 1, totalWindows });
    const cleaned = await cleanWindow(apiKey, windows[w], model);
    if (cleaned) {
      await opfs.appendFile(OPFS_PATHS.CLEANED_TRANSCRIPT, cleaned + "\n\n");
    }
    if (w < totalWindows - 1) {
      await sleep(GEMINI_REQUEST_DELAY_MS);
    }
  }

  // --- Stage 3: Divide into smaller portions, synthesize with pacing, store parts ---
  const cleanedTranscript = (await opfs.readText(OPFS_PATHS.CLEANED_TRANSCRIPT)).trim();
  if (!cleanedTranscript) {
    throw new Error("Text cleaning produced an empty transcript.");
  }

  const portions = partitionIntoPortions(cleanedTranscript, WORDS_PER_AUDIO_PORTION);
  const totalPortions = portions.length;

  const wordTimestamps = [];
  let timeBaseMs = 0;

  for (let i = 0; i < totalPortions; i++) {
    report(STAGE.SYNTHESIZING, { part: i + 1, totalParts: totalPortions });

    let portionResult = null;
    let synthError = null;

    // Retry each small portion up to 3 times with backoff if network or server hiccups occur
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        portionResult = await synthesizePortion(portions[i].text, voice);
        synthError = null;
        break;
      } catch (err) {
        synthError = err;
        console.warn(`Portion ${i + 1}/${totalPortions} failed on attempt ${attempt + 1}:`, err);
        await sleep(1500 * (attempt + 1));
      }
    }

    if (!portionResult) {
      throw synthError || new Error(`Failed to synthesize audio for portion ${i + 1}/${totalPortions}.`);
    }

    // Immediately save portion audio to disk in OPFS with 5-digit index padding
    const partFileName = `${OPFS_PATHS.PARTS_DIR}/part_${String(i + 1).padStart(5, "0")}.mp3`;
    await opfs.writeStream(partFileName, portionResult.blob);

    // Map timestamps relative to the entire audiobook
    for (const { charOffset, timeMs } of portionResult.wordTimestamps) {
      wordTimestamps.push({
        char: portions[i].startChar + charOffset,
        timeMs: timeBaseMs + timeMs,
      });
    }
    timeBaseMs += portionResult.durationMs;

    // "take time to generate audio" - pacing delay between portions to protect against Edge-TTS rate limits
    if (i < totalPortions - 1) {
      await sleep(TTS_PORTION_DELAY_MS);
    }
  }

  // Persist the transcript mapping
  await opfs.writeJSON(OPFS_PATHS.TRANSCRIPT_MAP, wordTimestamps);

  // --- Stage 4: Merge smaller portions into final audiobook ---
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
