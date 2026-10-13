import { OPFS_PATHS } from "./constants.js";
import { listDir, readFile, writeStream, remove } from "./opfs.js";

/**
 * Concatenates every part_NN.mp3 under parts/ into final_audiobook.mp3,
 * then deletes the intermediate parts directory. MP3's frame-based format
 * tolerates straight byte concatenation, so no re-encoding is needed.
 */
export async function stitchAndPurgeParts() {
  const names = await listDir(OPFS_PATHS.PARTS_DIR);
  const mp3Names = names.filter((n) => n.endsWith(".mp3")).sort();
  const blobs = [];
  for (const name of mp3Names) {
    const file = await readFile(`${OPFS_PATHS.PARTS_DIR}/${name}`);
    blobs.push(file);
  }
  await writeStream(OPFS_PATHS.FINAL_AUDIO, new Blob(blobs, { type: "audio/mpeg" }));

  for (const name of mp3Names) {
    await remove(`${OPFS_PATHS.PARTS_DIR}/${name}`);
  }
}
