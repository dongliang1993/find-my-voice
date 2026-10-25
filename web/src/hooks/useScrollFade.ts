import { useCallback } from 'react';

/**
 * Softens the edges of a scroller wherever there is more to see past them:
 * the top once it has been scrolled, the bottom until it reaches the end.
 * The bar itself comes only while it is being used, and goes again when it
 * is not (see .show-bar in index.css).
 * Written to data attributes, not state, so scrolling never renders.
 * Pair with the `scroll-fade` class.
 */
export function useScrollFade<T extends HTMLElement>() {
  return useCallback((el: T | null) => {
    if (!el) return;
    let settle: ReturnType<typeof setTimeout>;
    const update = () => {
      el.toggleAttribute('data-fade-top', el.scrollTop > 1);
      el.toggleAttribute('data-fade-bottom', el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    };
    // The bar appears only on the gesture, then leaves again. Overscroll and
    // momentum keep sending scrolls after the finger is up, so the settle is
    // long enough to cover them — not so long it feels like it never leaves.
    const wake = () => {
      clearTimeout(settle);
      el.toggleAttribute('data-show-bar', true);
      settle = setTimeout(() => el.toggleAttribute('data-show-bar', false), 900);
    };
    update();
    el.addEventListener('scroll', wake, { passive: true, capture: true });
    // Content grows on its own too: a letter being written, a list filling in.
    const resized = new ResizeObserver(update);
    resized.observe(el);
    const changed = new MutationObserver(update);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(settle);
      el.removeEventListener('scroll', wake, true);
      resized.disconnect();
      changed.disconnect();
    };
  }, []);
}
