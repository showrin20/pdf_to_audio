import { MSG, STAGE, STORAGE_KEYS, OPFS_PATHS, GEMINI_MODEL } from "../lib/constants.js";
import { remove } from "../lib/opfs.js";
import * as env from "../lib/env.generated.js";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS", "BLOBS"],
    justification:
      "Runs local PDF parsing, Gemini text cleaning, and Edge TTS synthesis off the service worker.",
  });
}

async function closeOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) await chrome.offscreen.closeDocument();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MSG.START_PIPELINE:
      handleStart(message);
      break;
    case MSG.PIPELINE_PROGRESS:
      chrome.storage.local.set({
        [STORAGE_KEYS.PIPELINE_STATE]: { stage: message.stage, ...message },
      });
      break;
    case MSG.PIPELINE_COMPLETE:
      chrome.storage.local.set({
        [STORAGE_KEYS.PIPELINE_STATE]: { stage: STAGE.READY },
      });
      closeOffscreenDocument();
      break;
    case MSG.PIPELINE_ERROR:
      chrome.storage.local.set({
        [STORAGE_KEYS.PIPELINE_STATE]: { stage: STAGE.ERROR, message: message.message },
      });
      closeOffscreenDocument();
      break;
    case MSG.RESET_PIPELINE:
      handleReset().then(() => sendResponse({ ok: true }));
      return true;
    default:
      break;
  }
  return undefined;
});

async function handleStart({ voice }) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PIPELINE_STATE]: { stage: STAGE.EXTRACTING },
  });
  const { [STORAGE_KEYS.GEMINI_API_KEY]: storedKey } = await chrome.storage.local.get(
    STORAGE_KEYS.GEMINI_API_KEY
  );
  // .env (via env.generated.js) is the default key source; a manually-entered
  // key in popup settings takes precedence if the user set one.
  const apiKey = storedKey || env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || GEMINI_MODEL;
  if (!apiKey) {
    chrome.storage.local.set({
      [STORAGE_KEYS.PIPELINE_STATE]: {
        stage: STAGE.ERROR,
        message: "No Gemini API key found. Add one in Settings or in .env.",
      },
    });
    return;
  }
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ type: MSG.START_PIPELINE, apiKey, model, voice }).catch(() => {});
}

async function handleReset() {
  await closeOffscreenDocument();
  await Promise.all([
    remove(OPFS_PATHS.SOURCE_PDF),
    remove(OPFS_PATHS.CLEANED_TRANSCRIPT),
    remove(OPFS_PATHS.TRANSCRIPT_MAP),
    remove(OPFS_PATHS.FINAL_AUDIO),
    remove(OPFS_PATHS.PARTS_DIR, { recursive: true }),
  ]);
  await chrome.storage.local.set({ [STORAGE_KEYS.PIPELINE_STATE]: { stage: STAGE.IDLE } });
}

// Purge the master audio + source PDF once the user's download finishes.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "complete") return;
  const { pendingDownloadId } = await chrome.storage.local.get("pendingDownloadId");
  if (pendingDownloadId !== delta.id) return;
  await remove(OPFS_PATHS.FINAL_AUDIO);
  await remove(OPFS_PATHS.SOURCE_PDF);
  await chrome.storage.local.remove("pendingDownloadId");
});
