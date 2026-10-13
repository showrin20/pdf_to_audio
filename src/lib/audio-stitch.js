import { OPFS_PATHS } from "./constants.js";
import { listDir, remove, streamMergeFiles } from "./opfs.js";

/**
 * Concatenates every portion mp3 under parts/ into final_audiobook.mp3 in strict
 * numerical order, streaming directly to disk to prevent RAM bloat, then purges
 * the intermediate portion files.
 */
export async function stitchAndPurgeParts() {
  const names = await listDir(OPFS_PATHS.PARTS_DIR);
  // Sort numerically so part_00001, part_00002, ..., part_00100 are strictly in order
  const mp3Names = names
    .filter((n) => n.endsWith(".mp3"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
      return numA - numB;
    });

  if (mp3Names.length === 0) {
    throw new Error("No audio portions found to merge.");
  }

  const partPaths = mp3Names.map((name) => `${OPFS_PATHS.PARTS_DIR}/${name}`);
  await streamMergeFiles(OPFS_PATHS.FINAL_AUDIO, partPaths);

  for (const name of mp3Names) {
    await remove(`${OPFS_PATHS.PARTS_DIR}/${name}`);
  }
}
