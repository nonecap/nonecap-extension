/**
 * Renders the NoneCap brand mark (purple rounded square with two white
 * strike bars, per the .nc-mark design) as PNG icons at 16/32/48/128.
 *
 * Run: bun scripts/gen-icons.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128] as const;

/** Gradient endpoints: linear-gradient(135deg, #7c4dff 0%, #4e1ed1 100%). */
const GRAD_FROM = { r: 0x7c, g: 0x4d, b: 0xff };
const GRAD_TO = { r: 0x4e, g: 0x1e, b: 0xd1 };

/** Signed distance from a point to a rounded rectangle (negative inside). */
function roundedRectSdf(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): number {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - radius);
  const qy = Math.abs(py - cy) - (h / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function renderIcon(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const samples = 4; // 4x4 supersampling per pixel for anti-aliasing

  // Rounded-square body (border-radius ~22% of the mark, like the design).
  const bodyRadius = size * 0.22;

  // Bars: inset 18% left/right, 18% tall, pill-shaped (.nc-mark::after/::before).
  const barX = size * 0.18;
  const barW = size * 0.64;
  const barH = size * 0.18;
  const topBarY = size * 0.18;
  const bottomBarY = size - size * 0.18 - barH;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bodyCov = 0;
      let topCov = 0;
      let bottomCov = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (roundedRectSdf(px, py, 0, 0, size, size, bodyRadius) <= 0) bodyCov++;
          if (roundedRectSdf(px, py, barX, topBarY, barW, barH, barH / 2) <= 0) topCov++;
          if (roundedRectSdf(px, py, barX, bottomBarY, barW, barH, barH / 2) <= 0) bottomCov++;
        }
      }

      const total = samples * samples;
      bodyCov /= total;
      topCov /= total;
      bottomCov /= total;

      // Gradient along the 135deg diagonal.
      const t = (x + y) / (2 * (size - 1));
      let r = GRAD_FROM.r + (GRAD_TO.r - GRAD_FROM.r) * t;
      let g = GRAD_FROM.g + (GRAD_TO.g - GRAD_FROM.g) * t;
      let b = GRAD_FROM.b + (GRAD_TO.b - GRAD_FROM.b) * t;

      // Composite the white bars over the body (0.85 top, 0.45 bottom).
      const topA = topCov * 0.85;
      const bottomA = bottomCov * 0.45;
      const barA = Math.min(1, topA + bottomA);
      r = r * (1 - barA) + 255 * barA;
      g = g * (1 - barA) + 255 * barA;
      b = b * (1 - barA) + 255 * barA;

      const idx = (y * size + x) * 4;
      png.data[idx] = Math.round(r);
      png.data[idx + 1] = Math.round(g);
      png.data[idx + 2] = Math.round(b);
      png.data[idx + 3] = Math.round(bodyCov * 255);
    }
  }

  return PNG.sync.write(png);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
