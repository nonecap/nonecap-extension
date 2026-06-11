# Solving architecture: trusted input via chrome.debugger

## Why

hCaptcha's image-grid clicks land as DOM clicks on `.task-image`, but its
drag and point-on-canvas puzzles read pointer input off a `<canvas>` and ignore
events with `isTrusted: false`. A content script can only ever produce
untrusted events, so synthetic drags do nothing. The puzzle never registers an
answer, the submit button stays on "Skip", and the solve fails.

The only way an extension can produce trusted input is the `chrome.debugger`
API: attach to the tab and dispatch `Input.dispatchMouseEvent` over the
DevTools Protocol. Those events carry `isTrusted: true` and are hit-tested by
the browser exactly like real mouse input, so they reach the challenge iframe's
canvas regardless of cross-origin boundaries. This is how production solver
extensions (NopeCha and similar) drive captchas.

## Coordinate model

CDP `Input.dispatchMouseEvent` takes **top-frame viewport CSS pixels** (not
device pixels, not iframe-local). The background already gets the challenge
iframe's rect in top-frame viewport coords via `GET_CHALLENGE_RECT` (it crops
the screenshot to exactly that rect). So conversion is:

- **points / drag** (vision returns 0-1000 normalized to the cropped image):
  `topX = rect.x + (p.x / 1000) * rect.width`,
  `topY = rect.y + (p.y / 1000) * rect.height`. The background needs nothing
  from the frame.
- **grid tiles** (vision returns 1-based indices): the background asks the
  challenge frame for each tile's centre in iframe-local CSS coords, then
  `topX = rect.x + localX`, `topY = rect.y + localY` (the iframe has no border
  and is not internally scrolled, the same assumption the crop already relies
  on).

No devicePixelRatio math is involved in input. Dpr only ever mattered for the
screenshot crop, which works the same way regardless.

## Responsibilities

- **background** owns the `chrome.debugger` lifecycle (attach on attempt start,
  detach on attempt end) and ALL real input. It converts coordinates and
  dispatches trusted CDP mouse events: clicks (approach moves, press, dwell,
  release) and drags (press, eased moves with the button held, release). It
  also tells the challenge frame where to animate the cosmetic cursor, in sync.
- **hCaptcha challenge frame** is a sensor and cursor host: it reports
  challenge readiness, answers a geometry query (tile / verify / refresh
  centres in iframe-local coords, with the verify button's Skip state), and
  animates the cosmetic cursor on request. It dispatches no real pointer
  events.
- **page / top frame** hosts the pill, detects the token, and provides the
  challenge rect.
- **checkbox / anchor frame**: the "I am human" click is a synthetic in-frame
  click, deliberately. It passes today, and if a future hCaptcha change ever
  gates it on trusted input the only consequence is the challenge opens, which
  the trusted path then solves. Revisit if passive-pass rates drop.

## The Skip guard

hCaptcha reuses `.button-submit` for both Verify/Next and Skip: it reads "Skip"
until an answer is placed. The executor refuses to click it while it reads
Skip (`findSubmitUnlessSkip`). After a trusted drag the button flips to Verify
and we click it; if a drag fails for any reason, we leave the button unclicked
and the round re-arms or the watchdog ends the attempt cleanly, instead of
skip-spamming through challenges.

## Known constraints

- **The debugger banner.** While attached, Chrome shows a "NoneCap started
  debugging this browser" infobar. Unavoidable with this API; we attach only
  during an active solve and detach when the attempt ends so it is not always
  present.
- **One debugger client per tab.** If DevTools is open on the tab, attach
  fails; we surface that as a normal solve failure (and could fall back to
  synthetic for grids). It also means the Playwright e2e harness, which itself
  holds the CDP session, CANNOT exercise the trusted-input path. That path is
  verified by unit tests on the driver and coordinate math, plus manual testing
  on a real hCaptcha page.
- **Permission cost.** The `debugger` permission carries a stronger install
  warning and stricter Chrome Web Store review. Accepted tradeoff: it is the
  only way to solve drag/point puzzles.

## Residual risk

- A hostile page embedding a real hCaptcha widget could reposition or overlay
  the challenge iframe so trusted clicks land on page-chosen targets. The
  background re-fetches the challenge rect immediately before acting, which
  shrinks the window between measuring and dispatching but does not eliminate
  it.
