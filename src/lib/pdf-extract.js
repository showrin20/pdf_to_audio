// Local PDF.js-based extraction. Runs in the offscreen document.
// Detects simple 2-column layouts via glyph x-position clustering and
// re-linearizes them into natural reading order; single-column pages are
// passed through using PDF.js's own (already-linear) item order.

let pdfjsLib = null;

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const mod = await import(chrome.runtime.getURL("src/vendor/pdfjs/pdf.min.mjs"));
  mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "src/vendor/pdfjs/pdf.worker.min.mjs"
  );
  pdfjsLib = mod;
  return mod;
}

const LINE_Y_TOLERANCE = 2.5; // pt; items within this delta share a line

function groupIntoLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= LINE_Y_TOLERANCE) {
      last.items.push(item);
      last.y = (last.y + item.y) / 2;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  return lines.map((line) => {
    const ordered = line.items.sort((a, b) => a.x - b.x);
    return ordered.map((i) => i.str).join("").replace(/\s+$/u, "");
  });
}

function detectColumns(items, pageWidth) {
  if (items.length < 20) return null; // too sparse to bother
  const mid = pageWidth / 2;
  const left = items.filter((i) => i.cx < mid);
  const right = items.filter((i) => i.cx >= mid);
  if (left.length < items.length * 0.15 || right.length < items.length * 0.15) {
    return null; // lopsided -> not really two columns
  }
  // A real two-column layout has a visible gutter: check that few items straddle the midline.
  const straddlers = items.filter(
    (i) => i.x < mid - 5 && i.x + i.width > mid + 5
  );
  if (straddlers.length > items.length * 0.1) return null;
  return { left, right };
}

async function extractPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items
    .filter((i) => i.str && i.str.trim().length > 0)
    .map((i) => ({
      str: i.str,
      x: i.transform[4],
      y: i.transform[5],
      width: i.width,
      cx: i.transform[4] + i.width / 2,
    }));

  const columns = detectColumns(items, viewport.width);
  let lines;
  if (columns) {
    lines = [...groupIntoLines(columns.left), ...groupIntoLines(columns.right)];
  } else {
    lines = groupIntoLines(items);
  }
  return lines.join("\n");
}

// Strips bare numeric-only lines (page numbers / margin line counters),
// a cheap pre-pass so the Gemini cleaner has less obvious garbage to chew on.
function stripBareNumberLines(pageText) {
  return pageText
    .split("\n")
    .filter((line) => !/^\s*\d{1,4}\s*$/.test(line))
    .join("\n");
}

/**
 * Extracts every page of a PDF (from an ArrayBuffer) to raw text.
 * Calls onPage(pageNumber, pageText, totalPages) as each page finishes so
 * callers can stream results instead of buffering the whole document.
 */
export async function extractPdfText(arrayBuffer, onPage) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const total = doc.numPages;
  for (let pageNum = 1; pageNum <= total; pageNum++) {
    const page = await doc.getPage(pageNum);
    const rawText = await extractPage(page);
    const cleanedOfNumbers = stripBareNumberLines(rawText);
    await onPage(pageNum, cleanedOfNumbers, total);
    page.cleanup();
  }
  await doc.destroy();
}
