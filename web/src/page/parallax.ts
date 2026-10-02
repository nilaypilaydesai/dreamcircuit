// Transform-only scroll parallax. An element with data-depth="d" is offset by d times the distance
// between the centre of its host (its horizon band or section) and the centre of the viewport:
// positive depths lag behind the scroll and read as far away, negative ones run ahead of it and
// read as near. Each frame reads every box first and writes every transform after, at most once
// per animation frame. Small screens get a gentler effect; prefers-reduced-motion turns it off,
// live, if the setting changes while the page is open.

interface Item { el: HTMLElement; depth: number; host: HTMLElement }

export function startParallax(): { refresh(): void } {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let items: Item[] = [];
  let queued = false;

  const collect = () => {
    items = [...document.querySelectorAll<HTMLElement>("[data-depth]")]
      .map((el) => ({
        el,
        depth: Number(el.dataset.depth) || 0,
        host: el.parentElement?.closest<HTMLElement>(".horizon, section") ?? el,
      }))
      .filter((it) => it.depth !== 0);
  };
  const frame = () => {
    queued = false;
    const vh = window.innerHeight;
    const gentle = window.innerWidth < 760 ? 0.6 : 1;
    const boxes = items.map((it) => it.host.getBoundingClientRect());
    items.forEach((it, i) => {
      const b = boxes[i];
      if (b.bottom < -vh * 0.5 || b.top > vh * 1.5) return; // far off screen: leave it be
      const off = -(b.top + b.height / 2 - vh / 2) * it.depth * gentle;
      it.el.style.transform = `translate3d(0, ${Math.round(off)}px, 0)`;
    });
  };
  const request = () => {
    if (queued || reduce.matches) return;
    queued = true;
    requestAnimationFrame(frame);
  };
  const onPreference = () => {
    if (reduce.matches) for (const it of items) it.el.style.transform = "";
    else request();
  };

  collect();
  window.addEventListener("scroll", request, { passive: true });
  window.addEventListener("resize", request, { passive: true });
  reduce.addEventListener("change", onPreference);
  request();
  return {
    refresh() {
      collect();
      request();
    },
  };
}
