import { OPFS_PATHS, STORAGE_KEYS } from "../lib/constants.js";
import { readText, readJSON, readFile, exists } from "../lib/opfs.js";
import { downloadAudiobook } from "../lib/download.js";
import { createMascot, bindMascotToAudio } from "../lib/mascot.js";

const audio = document.getElementById("audio");
const transcriptEl = document.getElementById("transcript");
const emptyState = document.getElementById("emptyState");
const titleEl = document.getElementById("title");
const readingProgressFill = document.getElementById("readingProgressFill");

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

const sentenceSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : null;

// Splits paragraph text into sentences, each tagged with its absolute char
// offset in the full transcript, so each one can get its own seek time.
function splitSentences(text, baseOffset) {
  const sentences = [];
  if (sentenceSegmenter) {
    for (const seg of sentenceSegmenter.segment(text)) {
      const trimmed = seg.segment.trim();
      if (!trimmed) continue;
      const leading = seg.segment.length - seg.segment.trimStart().length;
      sentences.push({ start: baseOffset + seg.index + leading, text: trimmed });
    }
    return sentences;
  }
  const re = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text))) {
    const trimmed = m[0].trim();
    if (!trimmed) continue;
    const leading = m[0].length - m[0].trimStart().length;
    sentences.push({ start: baseOffset + m.index + leading, text: trimmed });
  }
  return sentences;
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
    const sentences = splitSentences(para.text, para.start);
    for (const sentence of sentences) {
      const span = document.createElement("span");
      span.className = "sentence";
      span.textContent = sentence.text + " ";
      const seekTime = seekTimeForChar(map, sentence.start);
      span.addEventListener("click", () => {
        audio.currentTime = seekTime;
        audio.play();
      });
      p.appendChild(span);
      nodes.push({ el: span, seekTime });
    }
    transcriptEl.appendChild(p);
  }

  let activeIndex = -1;
  audio.addEventListener("timeupdate", () => {
    const t = audio.currentTime;
    if (audio.duration) {
      readingProgressFill.style.width = `${(t / audio.duration) * 100}%`;
    }

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
      const el = nodes[idx].el;
      el.classList.add("active");
      const rect = el.getBoundingClientRect();
      const inView = rect.top >= 80 && rect.bottom <= window.innerHeight - 40;
      if (!inView) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

init();
