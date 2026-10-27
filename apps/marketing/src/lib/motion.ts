/**
 * Runs continuous motion only while it can be seen: scenes ([data-motion]) use
 * `animation-play-state: var(--motion-state, paused)`, and this sets the state
 * off when a scene scrolls out, the tab hides, or reduced motion is preferred.
 * The optional parallax leans a field of marks toward a fine pointer.
 */
export function startMotion({
  scenes,
  parallax,
}: {
  scenes: HTMLElement[];
  parallax?: { area: HTMLElement; field: HTMLElement };
}) {
  if (typeof IntersectionObserver === "undefined") return () => {};

  const visible = new Set<Element>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const events = new AbortController();
  const eventOptions = { signal: events.signal };
  let disposed = false;
  let pointerFrame: number | undefined;
  let pointer: { x: number; y: number } | null = null;

  const canMove = (element: Element) =>
    !disposed &&
    visible.has(element) &&
    document.visibilityState === "visible" &&
    !reducedMotion.matches;
  const canParallax = () => !!parallax && finePointer.matches && canMove(parallax.field);

  function resetPointer() {
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pointer = null;
    parallax?.field.style.setProperty("--px", "0px");
    parallax?.field.style.setProperty("--py", "0px");
  }

  function update() {
    for (const scene of scenes) {
      scene.style.setProperty("--motion-state", canMove(scene) ? "running" : "paused");
    }
    if (parallax) {
      const on = canParallax();
      parallax.field.style.setProperty("--parallax-duration", on ? "0.7s" : "0s");
      if (!on) resetPointer();
    }
  }

  const observer = new IntersectionObserver((entries) => {
    if (disposed) return;
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    update();
  });
  for (const scene of scenes) observer.observe(scene);
  if (parallax && !scenes.includes(parallax.field)) observer.observe(parallax.field);

  if (parallax) {
    const { area, field } = parallax;
    area.addEventListener(
      "pointermove",
      (event) => {
        if (!canParallax()) return;
        pointer = { x: event.clientX, y: event.clientY };
        pointerFrame ??= requestAnimationFrame(() => {
          pointerFrame = undefined;
          if (!pointer || !canParallax()) return;
          const bounds = area.getBoundingClientRect();
          if (bounds.width === 0 || bounds.height === 0) return;
          field.style.setProperty(
            "--px",
            `${(((pointer.x - bounds.left) / bounds.width - 0.5) * 36).toFixed(1)}px`,
          );
          field.style.setProperty(
            "--py",
            `${(((pointer.y - bounds.top) / bounds.height - 0.5) * 28).toFixed(1)}px`,
          );
        });
      },
      eventOptions,
    );
    area.addEventListener("pointerleave", resetPointer, eventOptions);
  }

  document.addEventListener("visibilitychange", update, eventOptions);
  reducedMotion.addEventListener("change", update, eventOptions);
  finePointer.addEventListener("change", update, eventOptions);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    observer.disconnect();
    update();
  };
}
