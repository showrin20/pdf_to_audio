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
    let lineStr = "";
    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];
      if (i > 0) {
        const prev = ordered[i - 1];
        const prevEndsSpace = prev.str.endsWith(" ");
        const currStartsSpace = item.str.startsWith(" ");
        const hasGap = item.x > prev.x + prev.width + 1;
        if (!prevEndsSpace && !currStartsSpace && (hasGap || !prev.str.endsWith("-"))) {
          lineStr += " ";
        }
      }
      lineStr += item.str;
    }
    return lineStr.trim();
  });
}

function extractPageLayout(items, pageWidth) {
  if (items.length < 20) return groupIntoLines(items);

  const mid = pageWidth / 2;
  const left = items.filter((i) => i.cx < mid);
  const right = items.filter((i) => i.cx >= mid);

  if (left.length < items.length * 0.15 || right.length < items.length * 0.15) {
    return groupIntoLines(items);
  }

  const straddlers = items.filter(
    (i) => i.x < mid - 5 && i.x + i.width > mid + 5
  );

  // If very few straddlers (<8%), the page is a standard two-column layout
  if (straddlers.length <= items.length * 0.08) {
    return [...groupIntoLines(left), ...groupIntoLines(right)];
  }

  // Hybrid layout (typical for page 1: wide title/authors/abstract header across the top,
  // followed by two columns for the main body)
  const wideStraddlers = straddlers.filter((i) => i.width > pageWidth * 0.2);
  if (wideStraddlers.length > 0) {
    const minY = Math.min(...wideStraddlers.map((i) => i.y));
    const headerItems = items.filter((i) => i.y >= minY - LINE_Y_TOLERANCE);
    const bodyItems = items.filter((i) => i.y < minY - LINE_Y_TOLERANCE);

    const bodyLeft = bodyItems.filter((i) => i.cx < mid);
    const bodyRight = bodyItems.filter((i) => i.cx >= mid);
    if (bodyLeft.length >= 8 && bodyRight.length >= 8) {
      return [
        ...groupIntoLines(headerItems),
        ...groupIntoLines(bodyLeft),
        ...groupIntoLines(bodyRight),
      ];
    }
  }

  return groupIntoLines(items);
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

  const lines = extractPageLayout(items, viewport.width);
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
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const doc = await loadingTask.promise;
  const total = doc.numPages;
  for (let pageNum = 1; pageNum <= total; pageNum++) {
    const page = await doc.getPage(pageNum);
    const rawText = await extractPage(page);
    const cleanedOfNumbers = stripBareNumberLines(rawText);
    await onPage(pageNum, cleanedOfNumbers, total);
    page.cleanup();
  }
  await loadingTask.destroy();
}
