import { OPFS_PATHS, STORAGE_KEYS } from "../lib/constants.js";
import { readText, readJSON, readFile, exists } from "../lib/opfs.js";
import { downloadAudiobook } from "../lib/download.js";
import { createMascot, bindMascotToAudio } from "../lib/mascot.js";

const audio = document.getElementById("audio");
const transcriptEl = document.getElementById("transcript");
const emptyState = document.getElementById("emptyState");
const titleEl = document.getElementById("title");

const mascot = createMascot({ size: 48 });
document.getElementById("mascotSlot").appendChild(mascot);
bindMascotToAudio(mascot, audio);

document.getElementById("downloadBtn").addEventListener("click", () => downloadAudiobook());

function splitParagraphs(text) {
  const paragraphs = [];
  let cursor = 0;
  for (const block of text.split(/\n{2,}/)) {
    const start = text.indexOf(block, cursor);
    if (block.trim()) paragraphs.push({ start, text: block.trim() });
    cursor = start + block.length;
  }
  return paragraphs;
}

// Returns the timeMs of the last map entry whose char offset is <= target.
function seekTimeForChar(map, targetChar) {
  let lo = 0;
  let hi = map.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].char <= targetChar) {
      best = map[mid].timeMs;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best / 1000;
}

async function init() {
  const ready = await exists(OPFS_PATHS.FINAL_AUDIO);
  if (!ready) {
    emptyState.hidden = false;
    return;
  }

  const { [STORAGE_KEYS.DOCUMENT_TITLE]: title } = await chrome.storage.local.get(
    STORAGE_KEYS.DOCUMENT_TITLE
  );
  if (title) {
    titleEl.textContent = title;
    document.title = `${title} — Audiobook`;
  }

  const [transcript, map, audioFile] = await Promise.all([
    readText(OPFS_PATHS.CLEANED_TRANSCRIPT),
    readJSON(OPFS_PATHS.TRANSCRIPT_MAP),
    readFile(OPFS_PATHS.FINAL_AUDIO),
  ]);
  map.sort((a, b) => a.char - b.char);
  audio.src = URL.createObjectURL(audioFile);

  const paragraphs = splitParagraphs(transcript);
  const nodes = [];
  for (const para of paragraphs) {
    const p = document.createElement("p");
    p.textContent = para.text;
    const seekTime = seekTimeForChar(map, para.start);
    p.dataset.seekTime = String(seekTime);
    p.addEventListener("click", () => {
      audio.currentTime = seekTime;
      audio.play();
    });
    transcriptEl.appendChild(p);
    nodes.push({ el: p, seekTime });
  }

  let activeIndex = -1;
  audio.addEventListener("timeupdate", () => {
    const t = audio.currentTime;
    let idx = nodes.length - 1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].seekTime > t) {
        idx = i - 1;
        break;
      }
    }
    if (idx === activeIndex) return;
    if (activeIndex >= 0) nodes[activeIndex].el.classList.remove("active");
    activeIndex = idx;
    if (idx >= 0) {
      nodes[idx].el.classList.add("active");
      nodes[idx].el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

init();
