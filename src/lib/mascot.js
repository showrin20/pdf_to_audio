// A small always-animated mascot: a lazy cat wearing headphones, bobbing
// its head gently at rest and grooving faster whenever the extension is
// actually "listening" to something (pipeline running, or audio playing).

const SVG_MARKUP = `
<svg class="mascot" viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg">
  <path class="tail" d="M62,78 Q82,72 74,50" fill="none" stroke="#f4a94c" stroke-width="7" stroke-linecap="round" />
  <g class="head-group">
    <path class="ear-left" d="M26,30 L18,10 L38,24 Z" fill="#f4a94c" />
    <path d="M28,26 L24,14 L34,23 Z" fill="#fbcfa0" />
    <path class="ear-right" d="M74,30 L82,10 L62,24 Z" fill="#f4a94c" />
    <path d="M72,26 L76,14 L66,23 Z" fill="#fbcfa0" />

    <ellipse cx="50" cy="52" rx="24" ry="21" fill="#f4a94c" />
    <ellipse cx="50" cy="60" rx="14" ry="10" fill="#fff6ea" />

    <path d="M34,46 q4,-5 8,0" fill="none" stroke="#3f2d1a" stroke-width="2.4" stroke-linecap="round" />
    <path d="M58,46 q4,-5 8,0" fill="none" stroke="#3f2d1a" stroke-width="2.4" stroke-linecap="round" />
    <path d="M47,58 l3,3 l3,-3" fill="none" stroke="#e8795a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />

    <g stroke="#c9906a" stroke-width="1.2" opacity="0.8">
      <path d="M30,58 L14,55" />
      <path d="M30,62 L14,63" />
      <path d="M70,58 L86,55" />
      <path d="M70,62 L86,63" />
    </g>

    <path d="M22,32 Q50,2 78,32" fill="none" stroke="#334155" stroke-width="5" stroke-linecap="round" />
    <circle class="cup-glow" cx="22" cy="36" r="9" fill="#60a5fa" />
    <circle class="cup-glow" cx="78" cy="36" r="9" fill="#60a5fa" />
    <circle cx="22" cy="36" r="8" fill="#1e293b" stroke="#475569" stroke-width="2" />
    <circle cx="78" cy="36" r="8" fill="#1e293b" stroke="#475569" stroke-width="2" />
    <circle cx="19" cy="33" r="2" fill="#64748b" />
    <circle cx="75" cy="33" r="2" fill="#64748b" />

    <g>
      <rect class="eq-bar" x="68" y="40" width="2.5" height="8" fill="#93c5fd" />
      <rect class="eq-bar" x="73" y="40" width="2.5" height="8" fill="#93c5fd" />
      <rect class="eq-bar" x="78" y="40" width="2.5" height="8" fill="#93c5fd" />
    </g>
  </g>
</svg>`;

export function createMascot({ size = 56 } = {}) {
  const template = document.createElement("template");
  template.innerHTML = SVG_MARKUP.trim();
  const svg = template.content.firstElementChild;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(Math.round(size * 0.9)));
  return svg;
}

export function setMascotActive(mascotEl, active) {
  mascotEl.classList.toggle("active", active);
}

/** Keeps the mascot "grooving" in sync with an <audio> element's play state. */
export function bindMascotToAudio(mascotEl, audioEl) {
  audioEl.addEventListener("play", () => setMascotActive(mascotEl, true));
  audioEl.addEventListener("pause", () => setMascotActive(mascotEl, false));
  audioEl.addEventListener("ended", () => setMascotActive(mascotEl, false));
}
