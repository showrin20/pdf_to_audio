import { OPFS_PATHS, STORAGE_KEYS } from "./constants.js";
import { readFile } from "./opfs.js";

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "audiobook";
}

/** Reads the finished audiobook out of OPFS and hands it to the Downloads API. */
export async function downloadAudiobook() {
  const file = await readFile(OPFS_PATHS.FINAL_AUDIO);
  const { [STORAGE_KEYS.DOCUMENT_TITLE]: title } = await chrome.storage.local.get(
    STORAGE_KEYS.DOCUMENT_TITLE
  );
  const url = URL.createObjectURL(file);
  const filename = `${sanitizeFilename(title || "audiobook")}.mp3`;
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  await chrome.storage.local.set({ pendingDownloadId: downloadId });
  // Revoke after the browser has had time to read the blob into its download pipeline.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return downloadId;
}
