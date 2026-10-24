/**
 * A requestAnimationFrame loop that stops while the page is hidden. A
 * minimised desktop window does not always throttle rAF the way a background
 * tab does, so her coil would otherwise keep drawing to nobody.
 *
 * `draw` returns false to stop on its own (a still frame that is done);
 * `wake()` restarts a stopped loop. The returned `stop` ends it for good.
 */
export function frames(draw: (now: number) => boolean | void) {
  let frame = 0;
  let running = false;
  let disposed = false;

  const tick = (now: number) => {
    if (document.hidden) { running = false; return; }
    if (draw(now) === false) { running = false; return; }
    frame = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (running || disposed || document.hidden) return;
    running = true;
    frame = requestAnimationFrame(tick);
  };
  const onVisibility = () => { if (!document.hidden) wake(); };

  document.addEventListener('visibilitychange', onVisibility);
  wake();
  return {
    wake,
    stop: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
