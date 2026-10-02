import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A ballpoint loop drawn around whatever matters — the catalog's one hand-made mark.
 * The loop is re-plotted in real pixels for the box it circles, so the pen line keeps one
 * weight at any size and the draw-on animation can trace the whole stroke.
 * Position it with `inset` on `.biro` inside a `position: relative` parent.
 */

// One loop in a 100×60 box; it overshoots its start like a real pen stroke.
const LOOP: Array<[number, number]> = [
  [9, 33],
  [6, 17],
  [37, 4],
  [62, 5],
  [87, 6],
  [99, 21],
  [95, 37],
  [91, 52],
  [60, 58],
  [35, 55],
  [15, 53],
  [3, 44],
  [10, 28],
  [14, 19],
  [25, 13],
  [41, 11],
];

function plot(w: number, h: number): string {
  const p = LOOP.map(([x, y]) => `${((x * w) / 100).toFixed(1)} ${((y * h) / 60).toFixed(1)}`);
  let d = `M${p[0]}`;
  for (let i = 1; i < p.length; i += 3) d += ` C${p[i]} ${p[i + 1]} ${p[i + 2]}`;
  return d;
}

export function Biro({ draw = false, tilt = -3 }: { draw?: boolean; tilt?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ w: width, h: height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <span ref={ref} className={`biro${draw ? ' biro--draw' : ''}`} aria-hidden="true">
      {size && (
        <svg
          viewBox={`0 0 ${size.w} ${size.h}`}
          focusable="false"
          style={{ transform: `rotate(${tilt}deg)` }}
        >
          <path d={plot(size.w, size.h)} pathLength={1} />
        </svg>
      )}
    </span>
  );
}
