export type StaticMapTransform = {
  x: number;
  y: number;
  scale: number;
};

export const STATIC_MAP_MIN_SCALE = 1;
export const STATIC_MAP_MAX_SCALE = 3.25;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampStaticMapTransform(
  transform: StaticMapTransform,
  width: number,
  height: number,
): StaticMapTransform {
  const scale = clamp(
    transform.scale,
    STATIC_MAP_MIN_SCALE,
    STATIC_MAP_MAX_SCALE,
  );
  const maximumX = Math.max(0, (Math.max(0, width) * (scale - 1)) / 2);
  const maximumY = Math.max(0, (Math.max(0, height) * (scale - 1)) / 2);
  return {
    x: clamp(transform.x, -maximumX, maximumX),
    y: clamp(transform.y, -maximumY, maximumY),
    scale,
  };
}

export function zoomStaticMapTransform(
  transform: StaticMapTransform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
): StaticMapTransform {
  const scale = clamp(nextScale, STATIC_MAP_MIN_SCALE, STATIC_MAP_MAX_SCALE);
  const ratio = scale / transform.scale;
  return clampStaticMapTransform(
    {
      x: anchorX * (1 - ratio) + transform.x * ratio,
      y: anchorY * (1 - ratio) + transform.y * ratio,
      scale,
    },
    width,
    height,
  );
}
