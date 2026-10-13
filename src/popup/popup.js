import { MSG, STAGE, STORAGE_KEYS, OPFS_PATHS, DEFAULT_VOICE } from "../lib/constants.js";
import { writeStream } from "../lib/opfs.js";
import { downloadAudiobook } from "../lib/download.js";
import { createMascot, setMascotActive } from "../lib/mascot.js";

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

async function init() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.GEMINI_API_KEY,
    STORAGE_KEYS.TTS_VOICE,
    STORAGE_KEYS.PIPELINE_STATE,
  ]);
  if (stored[STORAGE_KEYS.GEMINI_API_KEY]) apiKeyInput.value = stored[STORAGE_KEYS.GEMINI_API_KEY];
  voiceSelect.value = stored[STORAGE_KEYS.TTS_VOICE] || DEFAULT_VOICE;
  renderState(stored[STORAGE_KEYS.PIPELINE_STATE] || { stage: STAGE.IDLE });
}

apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEYS.GEMINI_API_KEY]: apiKeyInput.value.trim() });
});
voiceSelect.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEYS.TTS_VOICE]: voiceSelect.value });
});

document.getElementById("fileDrop").addEventListener("click", (e) => {
  if (e.target !== fileInput) fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileLabel.textContent = file.name;
  const title = file.name.replace(/\.pdf$/i, "");
  await chrome.storage.local.set({ [STORAGE_KEYS.DOCUMENT_TITLE]: title });
  await writeStream(OPFS_PATHS.SOURCE_PDF, file);
  chrome.runtime.sendMessage({ type: MSG.START_PIPELINE, voice: voiceSelect.value });
  renderState({ stage: STAGE.EXTRACTING });
});

document.getElementById("openPlayer").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/player/player.html") });
});

document.getElementById("downloadBtn").addEventListener("click", async () => {
  await downloadAudiobook();
});

for (const id of ["startOver", "dismissError"]) {
  document.getElementById(id).addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: MSG.RESET_PIPELINE });
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
      return state.totalPages ? (state.page / state.totalPages) * 25 : 2;
    case STAGE.CLEANING:
      return 28;
    case STAGE.SYNTHESIZING: {
      if (!state.totalParts) return 30;
      const partBase = ((state.part - 1) / state.totalParts) * 55;
      const chunkFraction = state.totalChunks
        ? (state.chunk / state.totalChunks) * (55 / state.totalParts)
        : (state.part / state.totalParts) * 55;
      return 30 + (state.totalChunks ? partBase + chunkFraction : chunkFraction);
    }
    case STAGE.STITCHING:
      return 90;
    default:
      return 0;
  }
}

function progressLabel(state) {
  switch (state.stage) {
    case STAGE.EXTRACTING:
      return state.totalPages
        ? `Extracting page ${state.page}/${state.totalPages}…`
        : "Reading PDF…";
    case STAGE.CLEANING:
      return "Cleaning text with Gemini…";
    case STAGE.SYNTHESIZING: {
      if (!state.totalParts) return "Narrating…";
      const partStr = `part ${state.part}/${state.totalParts}`;
      const chunkStr =
        state.chunk && state.totalChunks
          ? ` (${Math.round((state.chunk / state.totalChunks) * 100)}%)`
          : "";
      return `Narrating ${partStr}${chunkStr}…`;
    }
    case STAGE.STITCHING:
      return "Stitching final audiobook…";
    default:
      return "Working…";
  }
}

init();
