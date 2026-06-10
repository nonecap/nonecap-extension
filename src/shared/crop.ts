/**
 * Crop math + worker-safe rasterisation for screenshot relay.
 *
 * computeCropRect is pure math (fully unit-tested). cropDataUrl uses only
 * service-worker-safe primitives: fetch, createImageBitmap, OffscreenCanvas.
 * No chrome.* and no DOM document access anywhere in this module.
 */

import type { RectLike } from './messages';

export type CropRect = {
  /** Integer source rect in device pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Downscale factor so the LONG output side caps at capW (never upscales). */
  scale: number;
  outW: number;
  outH: number;
};

/**
 * Convert a CSS-pixel rect to an integer device-pixel source rect plus the
 * output size after capping the long side at `capW`.
 *
 * Negative origins are clamped to 0 with the width/height trimmed
 * accordingly. Clamping against the actual source bitmap happens when the
 * rect is applied (see cropDataUrl), since only then are the dims known.
 */
export function computeCropRect(
  rectCss: RectLike,
  dpr: number,
  capW = 1024,
): CropRect {
  // Round edges (not sizes) so fractional dpr doesn't drift the rect.
  const left = Math.round(rectCss.x * dpr);
  const top = Math.round(rectCss.y * dpr);
  const right = Math.round((rectCss.x + rectCss.width) * dpr);
  const bottom = Math.round((rectCss.y + rectCss.height) * dpr);

  const sx = Math.max(0, left);
  const sy = Math.max(0, top);
  const sw = Math.max(0, right - sx);
  const sh = Math.max(0, bottom - sy);

  const longSide = Math.max(sw, sh);
  const scale = longSide > 0 ? Math.min(1, capW / longSide) : 1;
  const outW = Math.round(sw * scale);
  const outH = Math.round(sh * scale);

  return { sx, sy, sw, sh, scale, outW, outH };
}

/**
 * Crop a captured-tab data URL to the given CSS rect and return base64 PNG
 * WITHOUT the data-url prefix. The source rect is clamped against the actual
 * bitmap dimensions before drawing.
 *
 * Throws on: rect fully outside the bitmap, undecodable image data, or a
 * missing OffscreenCanvas 2d context — callers must wrap in try/catch
 * (unlike api.ts, exceptions DO cross this seam).
 */
export async function cropDataUrl(
  dataUrl: string,
  rectCss: RectLike,
  dpr: number,
  capW = 1024,
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const rect = computeCropRect(rectCss, dpr, capW);
    const sx = Math.min(rect.sx, bitmap.width);
    const sy = Math.min(rect.sy, bitmap.height);
    const sw = Math.min(rect.sw, bitmap.width - sx);
    const sh = Math.min(rect.sh, bitmap.height - sy);
    if (sw <= 0 || sh <= 0) {
      throw new Error('crop rect is outside the captured bitmap');
    }

    // Re-derive the output size in case bitmap clamping shrank the rect.
    const scale = Math.min(1, capW / Math.max(sw, sh));
    const outW = Math.max(1, Math.round(sw * scale));
    const outH = Math.max(1, Math.round(sh * scale));

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);

    const png = await canvas.convertToBlob({ type: 'image/png' });
    return base64FromArrayBuffer(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
