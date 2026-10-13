import { GEMINI_MODEL, WORDS_PER_CLEAN_WINDOW } from "./constants.js";

const SYSTEM_INSTRUCTION = `You are a precision text-cleaning and text-organization engine for audiobook narration.
Your ONLY function is to remove non-readable garbage text and organize the reading flow.

CRITICAL CONSTRAINTS:
1. ALWAYS START FROM THE VERY FIRST PAGE AND FIRST LINE:
   - Always preserve and include the document title, subtitle, chapter headings, and author name from the first page.
   - Do NOT omit, skip, or truncate the first page or document opening.
2. DO NOT CHANGE ANY WORDS. Do not rewrite, paraphrase, simplify, or edit the author's vocabulary.
3. DO NOT ADD ANY WORDS. Do not add introductions, explanations, summaries, or filler phrases (never output "Here is the cleaned text:").
4. REMOVE NON-READABLE GARBAGE TEXT:
   - Margin line serial numbers (e.g., "1\\n2\\n3...76\\n")
   - Running headers and footers (e.g., "WACV 2027 Submission #NNNN", "arXiv:2505.19291v3...", page numbers)
   - In-text citation callouts (e.g., "[17, 46]", "[28]", "[1, 51]")
   - Figure and table diagram labels and data cells that disrupt narrative flow
   - End-of-line hyphens (reconnect split words such as "prod-ucts" -> "products")
5. ORGANIZE:
   - Group sentences into clean, readable paragraphs separated by double newlines.
6. OUTPUT:
   - Output ONLY the verbatim, cleaned author text starting from the beginning.`;

const MAX_RETRIES = 5;

async function callGemini(apiKey, windowText, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: windowText }] }],
    generationConfig: { temperature: 0 },
  };

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        // Rate limit: back off progressively (e.g. 5s, 10s, 15s)
        const delay = 5000 * (attempt + 1);
        console.warn(`Gemini rate limited (429). Waiting ${delay}ms before retry ${attempt + 1}...`);
        await sleep(delay);
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`Gemini server error: ${res.status}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini request failed (${res.status}): ${text}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return text.trim();
    } catch (err) {
      lastError = err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

export function localFallbackClean(rawText) {
  return rawText
    // Remove standalone line numbers or page numbers
    .replace(/^\s*\d{1,4}\s*$/gm, "")
    // Remove citation brackets like [1], [1, 2], [1-3]
    .replace(/\[\d+(?:[,\s–-]+\d+)*\]/g, "")
    // Reconnect hyphenated words split across lines
    .replace(/(\w+)-\n(\w+)/g, "$1$2")
    // Normalize excessive newlines to double newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Splits extracted text into paragraph-respecting windows of ~windowWords each
 * for reliable, paced Gemini cleaning.
 */
export function partitionTextIntoWindows(text, windowWords = WORDS_PER_CLEAN_WINDOW) {
  const paragraphs = text.split(/\n{2,}/);
  const windows = [];
  let current = "";
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    if (currentWordCount + words > windowWords && current.trim()) {
      windows.push(current.trim());
      current = "";
      currentWordCount = 0;
    }
    current += (current ? "\n\n" : "") + trimmed;
    currentWordCount += words;
  }
  if (current.trim()) {
    windows.push(current.trim());
  }
  return windows;
}

/**
 * Accumulates streamed page text into ~WORDS_PER_CLEAN_WINDOW-word windows,
 * cutting only at paragraph breaks so sentences never get split across a
 * Gemini request. Call push() per page, flush() once at the end.
 */
export class TextWindower {
  constructor({ onWindow, windowWords = WORDS_PER_CLEAN_WINDOW }) {
    this.onWindow = onWindow;
    this.windowWords = windowWords;
    this.buffer = "";
  }

  async push(pageText) {
    this.buffer += (this.buffer ? "\n\n" : "") + pageText;
    while (wordCount(this.buffer) >= this.windowWords) {
      const cut = this._findCut();
      if (cut === -1) break; // no paragraph break yet; wait for more pages
      const windowText = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut).trim();
      if (windowText) await this.onWindow(windowText);
    }
  }

  async flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) await this.onWindow(rest);
  }

  // Finds a paragraph-break index at or after the target word count.
  _findCut() {
    const target = this.windowWords;
    const words = this.buffer.split(/\s+/);
    if (words.length < target) return -1;
    // Walk the buffer counting words until we pass the target, then search
    // forward for the next "\n\n" paragraph break.
    let count = 0;
    let idx = 0;
    for (const match of this.buffer.matchAll(/\S+/g)) {
      count++;
      if (count >= target) {
        idx = match.index + match[0].length;
        break;
      }
    }
    const breakIdx = this.buffer.indexOf("\n\n", idx);
    return breakIdx === -1 ? -1 : breakIdx + 2;
  }
}

export async function cleanWindow(apiKey, windowText, model = GEMINI_MODEL) {
  if (!apiKey) {
    return localFallbackClean(windowText);
  }
  try {
    const cleaned = await callGemini(apiKey, windowText, model);
    return cleaned || localFallbackClean(windowText);
  } catch (err) {
    console.warn("Gemini clean failed after retries; falling back to local cleaned text:", err);
    return localFallbackClean(windowText);
  }
}
