// Silent, single-pass icon-only simulation of the extension's workflow:
// pick a PDF -> processing. No copy anywhere by design; it's a visual
// walkthrough, not a help text. Plays through once, crossfading directly
// from scene to scene (no blank gap), then closes itself.

const STAGE_SVG = `
<svg class="htu-stage" viewBox="0 0 280 150" aria-hidden="true">
  <g class="htu-scene htu-scene-a">
    <rect x="30" y="45" width="220" height="70" rx="12" fill="none" stroke="#475569" stroke-width="2"
      stroke-dasharray="7 7" style="animation:htu-dropzone-flash 2.6s ease-in-out forwards" />
    <g transform="translate(140,92)">
      <g style="animation:htu-file-drop 2.6s ease-in-out forwards">
        <path d="M-14,-18 h20 l8,8 v28 h-28 z" fill="#1e293b" stroke="#64748b" stroke-width="1.5" />
        <path d="M6,-18 v8 h8" fill="none" stroke="#64748b" stroke-width="1.5" />
        <rect x="-10" y="-2" width="20" height="2.5" rx="1.25" fill="#3b82f6" />
        <rect x="-10" y="4" width="20" height="2.5" rx="1.25" fill="#3b82f6" opacity="0.7" />
        <rect x="-10" y="10" width="13" height="2.5" rx="1.25" fill="#3b82f6" opacity="0.5" />
      </g>
      <g style="animation:htu-cursor-drop 2.6s ease-in-out forwards">
        <path d="M0,0 L0,16 L4,12.5 L7,19 L9.5,18 L6.5,11.5 L12,11.5 Z" fill="#e2e8f0" stroke="#0f172a" stroke-width="1" />
      </g>
    </g>
  </g>

  <g class="htu-scene htu-scene-b">
    <g transform="translate(44,58)">
      <rect x="-14" y="-22" width="28" height="40" rx="4" fill="#1e293b" stroke="#475569" stroke-width="2" />
      <path d="M4,-22 v9 a3,3 0 0 0 3,3 h7" fill="none" stroke="#475569" stroke-width="2" />
      <rect x="-9" y="-4" width="18" height="2.5" rx="1.25" fill="#3b82f6" />
      <rect x="-9" y="2" width="18" height="2.5" rx="1.25" fill="#3b82f6" opacity="0.7" />
      <rect x="-9" y="8" width="12" height="2.5" rx="1.25" fill="#3b82f6" opacity="0.5" />
    </g>
    <line x1="68" y1="58" x2="212" y2="58" stroke="#1e293b" stroke-width="2" />
    <circle cx="68" cy="58" r="4" fill="#60a5fa" style="animation:htu-chip-travel 0.8s linear infinite;animation-delay:2.4s" />
    <circle cx="68" cy="58" r="4" fill="#60a5fa" style="animation:htu-chip-travel 0.8s linear infinite;animation-delay:2.65s" />
    <circle cx="68" cy="58" r="4" fill="#60a5fa" style="animation:htu-chip-travel 0.8s linear infinite;animation-delay:2.9s" />
    <g transform="translate(236,58)">
      <path d="M-16,8 v-8 a16,16 0 0 1 32,0 v8" fill="none" stroke="#475569" stroke-width="3" stroke-linecap="round" />
      <rect x="-19" y="6" width="7" height="13" rx="3.5" fill="#3b82f6" />
      <rect x="12" y="6" width="7" height="13" rx="3.5" fill="#3b82f6" />
      <rect x="-3" y="10" width="2.5" height="6" fill="#93c5fd" style="animation:htu-eq-bounce 0.9s ease-in-out infinite;animation-delay:2.6s;transform-origin:bottom" />
      <rect x="1.5" y="6" width="2.5" height="10" fill="#93c5fd" style="animation:htu-eq-bounce 0.9s ease-in-out infinite;animation-delay:2.75s;transform-origin:bottom" />
      <rect x="6" y="9" width="2.5" height="7" fill="#93c5fd" style="animation:htu-eq-bounce 0.9s ease-in-out infinite;animation-delay:2.9s;transform-origin:bottom" />
    </g>
    <rect x="30" y="108" width="220" height="7" rx="3.5" fill="#1e293b" />
    <rect x="30" y="108" width="0" height="7" rx="3.5" fill="#3b82f6"
      style="animation:htu-progress-fill 2.8s ease-in-out forwards;animation-delay:2.5s" />
  </g>
</svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 12 12"><path d="M1,1 L11,11 M11,1 L1,11" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round" /></svg>`;

// Total one-shot timeline: scene A (0-2.6s) crossfades directly into scene B
// (2.2-5.6s), which holds its finished frame until close.
const SEQUENCE_DURATION_MS = 6000;

export function createHowToUseOverlay(onClose) {
  const overlay = document.createElement("div");
  overlay.className = "htu-overlay";

  const card = document.createElement("div");
  card.className = "htu-card";

  const closeBtn = document.createElement("button");
  closeBtn.className = "htu-close";
  closeBtn.innerHTML = CLOSE_ICON;
  closeBtn.setAttribute("aria-label", "Close");

  const dots = document.createElement("div");
  dots.className = "htu-dots";
  const dotA = document.createElement("span");
  dotA.className = "htu-dot htu-dot-a";
  const dotB = document.createElement("span");
  dotB.className = "htu-dot htu-dot-b";
  dots.appendChild(dotA);
  dots.appendChild(dotB);

  card.innerHTML = STAGE_SVG;
  card.appendChild(closeBtn);
  card.appendChild(dots);
  overlay.appendChild(card);

  const close = () => {
    clearTimeout(autoCloseTimer);
    overlay.remove();
    if (onClose) onClose();
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Plays through once, then dismisses itself. No looping.
  const autoCloseTimer = setTimeout(close, SEQUENCE_DURATION_MS);

  return overlay;
}
