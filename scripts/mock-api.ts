/**
 * Mock NoneCap extension API for local end-to-end testing. DEV ONLY —
 * unauthenticated, binds to 127.0.0.1, never deploy or expose this.
 *
 * Run: bun scripts/mock-api.ts   (or: bun run mock-api)
 * Then point the extension at it: chrome.storage.local.set({ apiBase: 'http://localhost:8787' })
 *
 * The recognize endpoint walks RECOGNIZE_SCRIPT round by round for grid
 * tasks (edit the array to script other flows) and answers single/drag
 * tasks with a fixed drag, validates that the uploaded image is a decodable
 * PNG of at least 100x100, and logs request sizes. The script position
 * (recognizeCalls) only advances — restart the server (or POST /__reset) to
 * reset it between test runs.
 *
 * Test-harness endpoints (used by the Playwright e2e suite):
 *   GET  /__log    → { requests: JournalEntry[] } journal of every API call
 *   POST /__reset  → clears the journal and rewinds the recognize script
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
 * Scripted recognize responses for GRID tasks, consumed in order (last one
 * repeats). NOTE: the cursor never rewinds — restart the server (or POST
 * /__reset) to replay from round 1.
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

/**
 * Scripted recognize responses for SINGLE (drag / point-on-image) tasks,
 * consumed in order (last one repeats). Alternates a point click with a
 * refresh so the loop is exercised across genuine multi-round single
 * challenges: with the hcaptcha agent's post-exec re-arm probe, a
 * click_points answer that mutates the challenge refires CHALLENGE_READY for
 * the next round; a refresh tears the challenge down and loads a fresh one.
 * The scripted answers are not real recognitions, so hCaptcha keeps
 * re-challenging until the extension hits MAX_ROUNDS and reports
 * outcome 'failed' — exactly the loop motion the e2e suite proves.
 */
const SINGLE_SCRIPT: MockRecognizeResponse[] = [
  {
    action: 'click_points',
    points: [{ x: 500, y: 500 }],
    session: 'extsess_TEST',
    credits: { remaining: 99, resets_at: resetsAt() },
  },
  {
    action: 'refresh',
    session: 'extsess_TEST',
    credits: { remaining: 98, resets_at: resetsAt() },
  },
  {
    action: 'click_points',
    points: [{ x: 500, y: 500 }],
    session: 'extsess_TEST',
    credits: { remaining: 97, resets_at: resetsAt() },
  },
];
let singleCalls = 0;

/**
 * Request journal, served at GET /__log so an external test runner can
 * assert on what the extension actually sent (PNG validity, outcome pings).
 */
export type JournalEntry = {
  at: string;
  method: string;
  path: string;
  /** HTTP status the mock answered with. */
  status: number;
  /** recognize only: decoded PNG dimensions, or null when not a valid PNG. */
  png?: { width: number; height: number } | null;
  /** recognize only: selected fields of the request body. */
  recognize?: { task: string | null; host: string | null; session: string | null; imageBytes: number };
  /** outcome only: the parsed request body. */
  outcome?: { session: string | null; result: string | null; rounds: number | null };
};
const journal: JournalEntry[] = [];

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

function record(entry: Omit<JournalEntry, 'at'>): void {
  journal.push({ at: new Date().toISOString(), ...entry });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ---- test-harness endpoints (not part of the real API) -------------------

  if (method === 'GET' && path === '/__log') {
    send(res, 200, { requests: journal });
    return;
  }

  if (method === 'POST' && path === '/__reset') {
    journal.length = 0;
    recognizeCalls = 0;
    singleCalls = 0;
    console.log('[mock] POST /__reset: journal cleared, recognize scripts rewound');
    send(res, 200, { ok: true });
    return;
  }

  // ---- the mocked NoneCap extension API -------------------------------------

  if (method === 'POST' && path === '/v1/ext/register') {
    console.log('[mock] POST /v1/ext/register →', REGISTER_RESPONSE.key);
    record({ method, path, status: 200 });
    send(res, 200, REGISTER_RESPONSE);
    return;
  }

  if (method === 'POST' && path === '/v1/ext/recognize') {
    const body = await readBody(req);
    let parsed: { image?: string; task?: string; host?: string; session?: string | null } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      record({ method, path, status: 400, png: null });
      send(res, 400, { error: { code: 'bad_request', message: 'invalid JSON' } });
      return;
    }

    const image = typeof parsed.image === 'string' ? parsed.image : '';
    const dims = pngDimensions(image);
    const recognizeInfo = {
      task: parsed.task ?? null,
      host: parsed.host ?? null,
      session: parsed.session ?? null,
      imageBytes: image.length,
    };
    console.log(
      `[mock] POST /v1/ext/recognize #${recognizeCalls + 1}: body ${body.length} B, ` +
        `image ${image.length} B base64, task=${parsed.task ?? '?'} host=${parsed.host ?? '?'} ` +
        `session=${parsed.session ?? 'null'} png=${dims ? `${dims.width}x${dims.height}` : 'INVALID'}`,
    );
    if (dims === null) {
      console.error('[mock] ASSERT FAILED: image is not a decodable PNG');
      record({ method, path, status: 400, png: null, recognize: recognizeInfo });
      send(res, 400, { error: { code: 'bad_image', message: 'image is not a decodable PNG' } });
      return;
    }
    if (dims.width < 100 || dims.height < 100) {
      console.error(`[mock] ASSERT FAILED: PNG is ${dims.width}x${dims.height}, expected ≥100x100`);
      record({ method, path, status: 400, png: dims, recognize: recognizeInfo });
      send(res, 400, {
        error: { code: 'bad_image', message: `PNG too small: ${dims.width}x${dims.height}` },
      });
      return;
    }

    let response: MockRecognizeResponse;
    if (parsed.task === 'single') {
      response = SINGLE_SCRIPT[Math.min(singleCalls, SINGLE_SCRIPT.length - 1)]!;
      singleCalls += 1;
    } else {
      response = RECOGNIZE_SCRIPT[Math.min(recognizeCalls, RECOGNIZE_SCRIPT.length - 1)]!;
      recognizeCalls += 1;
    }
    record({ method, path, status: 200, png: dims, recognize: recognizeInfo });
    send(res, 200, response);
    return;
  }

  if (method === 'POST' && path === '/v1/ext/outcome') {
    const body = await readBody(req);
    console.log('[mock] POST /v1/ext/outcome:', body);
    let parsed: { session?: string; result?: string; rounds?: number } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // keep nulls — the journal entry still records that the ping arrived
    }
    record({
      method,
      path,
      status: 200,
      outcome: {
        session: parsed.session ?? null,
        result: parsed.result ?? null,
        rounds: parsed.rounds ?? null,
      },
    });
    send(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/v1/ext/stats') {
    console.log('[mock] GET /v1/ext/stats');
    record({ method, path, status: 200 });
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
