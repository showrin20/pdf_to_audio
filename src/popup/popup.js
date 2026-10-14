import { MSG, STAGE, STORAGE_KEYS, OPFS_PATHS, DEFAULT_VOICE } from "../lib/constants.js";
import { writeStream } from "../lib/opfs.js";
import { downloadAudiobook } from "../lib/download.js";
import { createMascot, setMascotActive } from "../lib/mascot.js";
import { createHowToUseOverlay } from "../lib/how-to-use.js";

const mascot = createMascot({ size: 44 });
document.getElementById("mascotSlot").appendChild(mascot);

const WORKING_STAGES = new Set([
  STAGE.EXTRACTING,
  STAGE.CLEANING,
  STAGE.SYNTHESIZING,
  STAGE.STITCHING,
]);

const apiKeyInput = document.getElementById("apiKey");
const voiceSelect = document.getElementById("voice");
const fileInput = document.getElementById("fileInput");
const fileLabel = document.getElementById("fileLabel");
const progressSection = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const doneSection = document.getElementById("done");
const errorSection = document.getElementById("errorBox");
const errorText = document.getElementById("errorText");

let guideOpen = false;
function openHowToUse() {
  if (guideOpen) return;
  guideOpen = true;
  document.body.appendChild(
    createHowToUseOverlay(() => {
      guideOpen = false;
    })
  );
}

document.getElementById("howToUseBtn").addEventListener("click", openHowToUse);

async function init() {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.GEMINI_API_KEY,
      STORAGE_KEYS.TTS_VOICE,
      STORAGE_KEYS.PIPELINE_STATE,
      STORAGE_KEYS.HAS_SEEN_GUIDE,
    ]);
    if (stored[STORAGE_KEYS.GEMINI_API_KEY]) apiKeyInput.value = stored[STORAGE_KEYS.GEMINI_API_KEY];
    voiceSelect.value = stored[STORAGE_KEYS.TTS_VOICE] || DEFAULT_VOICE;
    renderState(stored[STORAGE_KEYS.PIPELINE_STATE] || { stage: STAGE.IDLE });

    if (!stored[STORAGE_KEYS.HAS_SEEN_GUIDE]) {
      await chrome.storage.local.set({ [STORAGE_KEYS.HAS_SEEN_GUIDE]: true });
      openHowToUse();
    }
  } catch (err) {
    console.warn("Popup init failed:", err);
  }
}

apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEYS.GEMINI_API_KEY]: apiKeyInput.value.trim() }).catch(() => {});
});
voiceSelect.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEYS.TTS_VOICE]: voiceSelect.value }).catch(() => {});
});

document.getElementById("fileDrop").addEventListener("click", (e) => {
  if (e.target !== fileInput) fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileLabel.textContent = file.name;
  const title = file.name.replace(/\.pdf$/i, "");
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.DOCUMENT_TITLE]: title });
    await writeStream(OPFS_PATHS.SOURCE_PDF, file);
    await chrome.runtime.sendMessage({ type: MSG.START_PIPELINE, voice: voiceSelect.value });
    renderState({ stage: STAGE.EXTRACTING });
  } catch (err) {
    console.error("Failed to start pipeline:", err);
    renderState({ stage: STAGE.ERROR, message: err?.message || "Failed to start extraction." });
  }
});

document.getElementById("openPlayer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/player/player.html") });
});

document.getElementById("downloadBtn").addEventListener("click", async () => {
  try {
    await downloadAudiobook();
  } catch (err) {
    console.warn("Download failed:", err);
    renderState({ stage: STAGE.ERROR, message: err?.message || "Audiobook file not ready yet." });
  }
});

for (const id of ["newGeneration", "dismissError"]) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: MSG.RESET_PIPELINE });
    } catch {
      // Ignored if service worker is inactive
    }
    fileInput.value = "";
    fileLabel.textContent = "Choose a PDF…";
    renderState({ stage: STAGE.IDLE });
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    message.type === MSG.PIPELINE_PROGRESS ||
    message.type === MSG.PIPELINE_ERROR ||
    message.type === MSG.PIPELINE_COMPLETE
  ) {
    const stage =
      message.type === MSG.PIPELINE_COMPLETE
        ? STAGE.READY
        : message.type === MSG.PIPELINE_ERROR
          ? STAGE.ERROR
          : message.stage;
    renderState({ ...message, stage });
  }
});

function renderState(state) {
  progressSection.hidden = true;
  doneSection.hidden = true;
  errorSection.hidden = true;
  setMascotActive(mascot, WORKING_STAGES.has(state.stage));

  switch (state.stage) {
    case STAGE.ERROR:
      errorSection.hidden = false;
      errorText.textContent = state.message || "Something went wrong.";
      break;
    case STAGE.READY:
      doneSection.hidden = false;
      break;
    case STAGE.IDLE:
      break;
    default:
      progressSection.hidden = false;
      progressFill.style.width = `${progressFraction(state)}%`;
      progressText.textContent = progressLabel(state);
      break;
  }
}

function progressFraction(state) {
  switch (state.stage) {
    case STAGE.EXTRACTING:
      return state.totalPages ? (state.page / state.totalPages) * 20 : 2;
    case STAGE.CLEANING:
      return state.totalWindows
        ? 20 + (state.window / state.totalWindows) * 15
        : 25;
    case STAGE.SYNTHESIZING: {
      if (!state.totalParts) return 35;
      return 35 + (state.part / state.totalParts) * 55;
    }
    case STAGE.STITCHING:
      return 92;
    default:
      return 0;
  }
}

function progressLabel(state) {
  switch (state.stage) {
    case STAGE.EXTRACTING:
      return state.totalPages
        ? `Extracting page ${state.page}/${state.totalPages}…`
        : "Reading PDF from page 1…";
    case STAGE.CLEANING:
      return state.totalWindows
        ? `Cleaning text with Gemini (${state.window}/${state.totalWindows})…`
        : "Cleaning text with Gemini…";
    case STAGE.SYNTHESIZING: {
      if (!state.totalParts) return "Generating audio…";
      const pct = Math.round((state.part / state.totalParts) * 100);
      return `Narrating portion ${state.part}/${state.totalParts} (${pct}%)…`;
    }
    case STAGE.STITCHING:
      return "Merging audio portions into final audiobook…";
    default:
      return "Working…";
  }
}

init();
