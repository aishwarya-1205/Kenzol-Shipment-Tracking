// Native scrolling only: the wheel/trackpad stays 1:1 with the browser, and programmatic
// jumps use the built-in smooth behaviour (instant for reduced-motion users).
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const behavior = (immediate) => (immediate || prefersReducedMotion() ? "auto" : "smooth");

export function scrollToTop({ immediate = false } = {}) {
  window.scrollTo({ top: 0, behavior: behavior(immediate) });
}

export function scrollToElement(element, offset = -24) {
  if (!element) return;
  const top = element.getBoundingClientRect().top + window.scrollY + offset;
  window.scrollTo({ top, behavior: behavior(false) });
}
