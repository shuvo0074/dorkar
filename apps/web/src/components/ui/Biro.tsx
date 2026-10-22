/**
 * The "this one" mark: a rounded accent ring around whatever matters (the chosen tile, this
 * device, the peak day). `draw` makes it pop in. Position it with `inset` on `.biro` inside a
 * `position: relative` parent. (`tilt` is accepted for older call sites and has no effect.)
 */
export function Biro({ draw = false }: { draw?: boolean; tilt?: number }) {
  return <span className={`biro${draw ? ' biro--draw' : ''}`} aria-hidden="true" />;
}
