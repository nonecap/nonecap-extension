/**
 * Mock NoneCap extension API for local end-to-end testing. DEV ONLY —
 * unauthenticated, binds to 127.0.0.1, never deploy or expose this.
 *
 * Run: bun scripts/mock-api.ts   (or: bun run mock-api)
 * Then point the extension at it: chrome.storage.local.set({ apiBase: 'http://localhost:8787' })
 *
 * The recognize endpoint walks RECOGNIZE_SCRIPT round by round (edit the
 * array to script other flows), validates that the uploaded image is a
 * decodable PNG of at least 100x100, and logs request sizes. The script
 * position (recognizeCalls) only advances — restart the server to reset it
 * between test runs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 8787;

type MockRecognizeResponse = {
  action: 'click_tiles' | 'click_points' | 'drag' | 'refresh';
  tiles?: number[];
  points?: { x: number; y: number }[];
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  moves?: { from: { x: number; y: number }; to: { x: number; y: number } }[];
  session: string;
  credits?: { remaining: number; resets_at: string };
};

const resetsAt = (): string => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};

/**
 * Scripted recognize responses, consumed in order (last one repeats).
 * NOTE: the cursor never rewinds — restart the server to replay from round 1.
 */
const RECOGNIZE_SCRIPT: MockRecognizeResponse[] = [
  {
    action: 'click_tiles',
    tiles: [1, 3],
    session: 'extsess_TEST',
    credits: { remaining: 99, resets_at: resetsAt() },
  },
  {
    action: 'click_tiles',
    tiles: [],
    session: 'extsess_TEST',
    credits: { remaining: 98, resets_at: resetsAt() },
  },
];
let recognizeCalls = 0;

const REGISTER_RESPONSE = { key: 'nc_ext_MOCK0000000000000000', daily_limit: 100 };
const STATS_RESPONSE = { month_solves: 128, month_credits_spent: 1280, solve_rate: 0.93 };

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...CORS_HEADERS });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Decode the PNG header: 8-byte signature, then the IHDR chunk where width
 * and height live at byte offsets 16-19 / 20-23 (big-endian). No deps needed.
 */
function pngDimensions(base64: string): { width: number; height: number } | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  // Bytes 12-15 must spell "IHDR".
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (method === 'POST' && path === '/v1/ext/register') {
    console.log('[mock] POST /v1/ext/register →', REGISTER_RESPONSE.key);
    send(res, 200, REGISTER_RESPONSE);
    return;
  }

  if (method === 'POST' && path === '/v1/ext/recognize') {
    const body = await readBody(req);
    let parsed: { image?: string; task?: string; host?: string; session?: string | null } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      send(res, 400, { error: { code: 'bad_request', message: 'invalid JSON' } });
      return;
    }

    const image = typeof parsed.image === 'string' ? parsed.image : '';
    const dims = pngDimensions(image);
    console.log(
      `[mock] POST /v1/ext/recognize #${recognizeCalls + 1}: body ${body.length} B, ` +
        `image ${image.length} B base64, task=${parsed.task ?? '?'} host=${parsed.host ?? '?'} ` +
        `session=${parsed.session ?? 'null'} png=${dims ? `${dims.width}x${dims.height}` : 'INVALID'}`,
    );
    if (dims === null) {
      console.error('[mock] ASSERT FAILED: image is not a decodable PNG');
      send(res, 400, { error: { code: 'bad_image', message: 'image is not a decodable PNG' } });
      return;
    }
    if (dims.width < 100 || dims.height < 100) {
      console.error(`[mock] ASSERT FAILED: PNG is ${dims.width}x${dims.height}, expected ≥100x100`);
      send(res, 400, {
        error: { code: 'bad_image', message: `PNG too small: ${dims.width}x${dims.height}` },
      });
      return;
    }

    const idx = Math.min(recognizeCalls, RECOGNIZE_SCRIPT.length - 1);
    recognizeCalls += 1;
    send(res, 200, RECOGNIZE_SCRIPT[idx]);
    return;
  }

  if (method === 'POST' && path === '/v1/ext/outcome') {
    const body = await readBody(req);
    console.log('[mock] POST /v1/ext/outcome:', body);
    send(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/v1/ext/stats') {
    console.log('[mock] GET /v1/ext/stats');
    send(res, 200, STATS_RESPONSE);
    return;
  }

  send(res, 404, { error: { code: 'not_found', message: `no route for ${method} ${path}` } });
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('[mock] handler error:', err);
    send(res, 500, { error: { code: 'internal', message: 'mock server error' } });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] NoneCap mock API (dev only) listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock] point the extension at it: chrome.storage.local.set({ apiBase: 'http://localhost:${PORT}' })`);
});
