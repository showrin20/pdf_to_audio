# PDF to Audiobook

A Chrome extension that turns any PDF into a narrated audiobook, entirely on your machine:

1. **Extract** — text is pulled out of the PDF locally with `pdf.js`.
2. **Clean** — the raw extracted text is sent to Gemini to fix line breaks, headers, hyphenation, and other PDF-extraction artifacts.
3. **Narrate** — the cleaned text is synthesized into speech with Microsoft Edge TTS (offline, free, British voices).
4. **Stitch** — the narrated parts are combined into a single MP3 you can play in-browser or download.

## Requirements

- Google Chrome (Manifest V3, uses `offscreen`, `storage`, and OPFS APIs).
- Node.js + npm (only needed once, to install dependencies and vendor `pdf.js`).
- A [Gemini API key](https://aistudio.google.com/apikey) for the text-cleanup step.

## Setup

1. Install dependencies and vendor the `pdf.js` worker files:

   ```bash
   npm install
   npm run vendor:pdfjs
   ```

2. Add your Gemini API key. Create a `.env` file in the project root:

   ```
   GEMINI_API_KEY=your-key-here
   GEMINI_MODEL=gemini-3.1-flash-lite
   ```

   Then generate the bundled fallback the extension reads at runtime:

   ```bash
   npm run sync-env
   ```

   Re-run `npm run sync-env` any time you change `.env`. Alternatively, skip this step and paste the key directly into the extension's Settings panel — a key entered there overrides `.env`.

3. Load the extension in Chrome:

   - Go to `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked**
   - Select this project's root folder

## Usage

1. Click the extension icon to open the popup.
2. (Optional) Open **⚙ Settings** to paste a Gemini API key (if you skipped `.env`) or pick a narration voice (Sonia or Ryan, both British).
3. Click **Choose a PDF…** and select a file. The pipeline starts automatically and the popup shows progress through extraction → cleaning → narration → stitching.
4. When it's done:
   - **Open Player** — opens a tab with an audio player and synced transcript.
   - **Download Audiobook** — saves the final MP3 to your downloads. Once the download completes, the extension clears the generated audio and source PDF from local storage to free up space.
5. Click **Start Over** at any time to discard the current job and upload a new PDF.

## Notes

- Everything runs locally except the Gemini cleanup call — no PDF content or audio is uploaded elsewhere.
- Files are stored temporarily in the browser's Origin Private File System (OPFS) during processing and are cleaned up after a successful download or when you start over.
- `.env` and the generated `src/lib/env.generated.js` are gitignored — don't commit your API key.
