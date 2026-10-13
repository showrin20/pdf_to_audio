// OPFS file/directory names used throughout the pipeline.
export const OPFS_PATHS = {
  SOURCE_PDF: "source.pdf",
  CLEANED_TRANSCRIPT: "cleaned_transcript.txt",
  TRANSCRIPT_MAP: "transcript_map.json",
  PARTS_DIR: "parts",
  FINAL_AUDIO: "final_audiobook.mp3",
};

// chrome.storage.local keys.
export const STORAGE_KEYS = {
  GEMINI_API_KEY: "geminiApiKey",
  TTS_VOICE: "ttsVoice",
  PIPELINE_STATE: "pipelineState",
  DOCUMENT_TITLE: "documentTitle",
};

// Runtime message types exchanged between popup / background / offscreen / player.
export const MSG = {
  START_PIPELINE: "start-pipeline",
  PIPELINE_PROGRESS: "pipeline-progress",
  PIPELINE_ERROR: "pipeline-error",
  PIPELINE_COMPLETE: "pipeline-complete",
  ENSURE_OFFSCREEN: "ensure-offscreen",
  DOWNLOAD_AUDIOBOOK: "download-audiobook",
  GET_STATE: "get-state",
  RESET_PIPELINE: "reset-pipeline",
};

// Pipeline stages, in order, used to drive progress UI.
export const STAGE = {
  IDLE: "idle",
  EXTRACTING: "extracting",
  CLEANING: "cleaning",
  SYNTHESIZING: "synthesizing",
  STITCHING: "stitching",
  READY: "ready",
  ERROR: "error",
};

export const WORDS_PER_CLEAN_WINDOW = 2500;
export const WORDS_PER_AUDIO_PART = 7500; // ~50 minutes at ~150 wpm narration
export const DEFAULT_VOICE = "en-GB-SoniaNeural";
export const GEMINI_MODEL = "gemini-3.1-flash-lite";
