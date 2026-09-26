/**
 * The wireframe sphere at the centre of the screen.
 *
 * Built from CSS-transformed rings rather than a canvas or a per-frame
 * redraw, and that is a decision about this machine rather than a stylistic
 * one. The reported hardware has no usable GPU for inference and a CPU that
 * manages single-digit tokens a second; an ornament that repaints sixty times
 * a second would be taking cycles from the only thing on screen that matters.
 *
 * A 3D CSS rotation is handed to the compositor and costs the main thread
 * nothing. The sphere is real geometry - meridians rotated about the vertical
 * axis, parallels stacked and scaled - so it reads as a rotating solid rather
 * than a spinning flat drawing.
 *
 * It stops entirely under `prefers-reduced-motion`, where a permanently
 * moving object is not decoration but an obstacle.
 */

/** Meridians: vertical great circles, evenly spaced around the axis. */
const MERIDIANS = 9;

/**
 * Parallels, as a fraction of the radius from the equator.
 *
 * Uneven on purpose: evenly spaced parallels look like a barrel, because a
 * sphere's horizontal slices crowd towards the poles. These are the sines of
 * even angles, which is what a sphere actually does.
 */
const PARALLELS = [0, 0.34, 0.64, 0.87];

export function Globe({ size = 190 }: { size?: number }) {
  const radius = size / 2;

  return (
    <div className="hx-globe" style={{ width: size, height: size }} aria-hidden="true">
      <div className="hx-globe__spin">
        {Array.from({ length: MERIDIANS }, (_, index) => (
          <span
            key={`m${index}`}
            className="hx-globe__ring"
            style={{ transform: `rotateY(${(index * 180) / MERIDIANS}deg)` }}
          />
        ))}

        {PARALLELS.flatMap((offset) => (offset === 0 ? [0] : [offset, -offset])).map((signed) => (
          <span
            key={`p${signed}`}
            className="hx-globe__ring hx-globe__ring--parallel"
            style={{
              // Laid flat, then lifted along the axis and shrunk to the
              // chord at that latitude. Pixels rather than percentages
              // because translateZ takes no percentage - the first attempt
              // used one and the rings collapsed into flat lines.
              transform: `rotateX(90deg) translateZ(${(signed * radius).toFixed(2)}px) scale(${Math.sqrt(
                1 - signed * signed,
              ).toFixed(3)})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
