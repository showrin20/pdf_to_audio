import { GEMINI_MODEL, WORDS_PER_CLEAN_WINDOW } from "./constants.js";

const SYSTEM_INSTRUCTION = `You are a precision text-cleaning and text-organization engine for audiobook narration.
Your ONLY function is to remove non-readable garbage text and organize the reading flow.

CRITICAL CONSTRAINTS:
1. DO NOT CHANGE ANY WORDS. Do not rewrite, paraphrase, simplify, or edit the author's vocabulary.
2. DO NOT ADD ANY WORDS. Do not add introductions, explanations, summaries, or filler phrases (never output "Here is the cleaned text:").
3. REMOVE ALL GARBAGE TEXT:
   - Margin line serial numbers (e.g., "1\\n2\\n3...76\\n")
   - Running headers and footers (e.g., "WACV 2027 Submission #NNNN", "arXiv:2505.19291v3...")
   - Page numbering digits at page boundaries (e.g., standalone "1", "2", "3")
   - Author metadata, email addresses, affiliations, and dates
   - In-text citation callouts (e.g., "[17, 46]", "[28]", "[1, 51]")
   - Figure and table diagram labels and data cells that disrupt narrative flow
   - End-of-line hyphens (reconnect split words such as "prod-ucts" -> "products")
4. ORGANIZE:
   - If the raw text is from a two-column layout, reorder it so that the entire first column is read top-to-bottom, followed by the entire second column.
   - Group sentences into clean, readable paragraphs separated by double newlines.
5. OUTPUT:
   - Output ONLY the verbatim, cleaned author text.`;

const MAX_RETRIES = 3;

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
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Gemini ${res.status}`);
        await sleep(600 * (attempt + 1));
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
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
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
  return callGemini(apiKey, windowText, model);
}
