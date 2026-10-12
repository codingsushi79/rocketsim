// SAS mode icons: the same symbols and colours as the navball markers (navball.ts), so the
// buttons around the ball read as part of it.

const C = { pro: "#e8d64a", nrm: "#c86ce0", rad: "#5fd8e8", tgt: "#ff5fa8", mnv: "#4d8dff", sys: "#e4e8ec" };
const svg = (body: string) => `<svg viewBox="-12 -12 24 24" width="100%" height="100%" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const circleTicks = (c: string) => `<circle r="5.5" stroke="${c}"/><circle r="1.4" fill="${c}" stroke="none"/><path d="M0-5.5V-9M-5.5 0H-9M5.5 0H9" stroke="${c}"/>`;
const xMark = (c: string) => `<circle r="5.5" stroke="${c}"/><path d="M-3.9-3.9L3.9 3.9M3.9-3.9L-3.9 3.9M0-5.5V-9M-5.5 0H-9M5.5 0H9" stroke="${c}"/>`;
const tri = (c: string, filled: boolean) => `<path d="M0-7L6.4 4.4H-6.4Z" stroke="${c}" ${filled ? `fill="${c}"` : ""}/>`;
const dotRing = (c: string, filled: boolean) => `<circle r="6" stroke="${c}"/><circle r="2" stroke="${c}" ${filled ? `fill="${c}"` : ""}/>`;

/** One icon per SAS mode, in SAS_MODES order. */
export const SAS_ICONS: string[] = [
  svg(`<path d="M0-8V-1" stroke="${C.sys}"/><path d="M-5.2-5.2A7.4 7.4 0 1 0 5.2-5.2" stroke="${C.sys}"/>`), // Off
  svg(`<rect x="-5" y="-1" width="10" height="7.5" rx="1" stroke="${C.sys}"/><path d="M-3-1V-4A3 3 0 0 1 3-4V-1" stroke="${C.sys}"/>`), // Hold
  svg(circleTicks(C.pro)), // Prograde
  svg(xMark(C.pro)), // Retrograde
  svg(tri(C.nrm, true)), // Normal
  svg(tri(C.nrm, false)), // Anti-normal
  svg(dotRing(C.rad, true)), // Radial out
  svg(dotRing(C.rad, false)), // Radial in
  svg(circleTicks(C.tgt)), // Target
  svg(xMark(C.tgt)), // Anti-target
  svg(`<circle r="6" stroke="${C.mnv}"/><path d="M-3 0H3M0-3V3" stroke="${C.mnv}"/>`), // Maneuver
];
