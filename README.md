<p align="center">
  <img src="public/icons/icon128.png" width="96" alt="NoneCap logo">
</p>

<h1 align="center">NoneCap hCaptcha Auto Solver</h1>

<p align="center">
  <a href="https://github.com/nonecap/nonecap-extension/actions/workflows/ci.yml"><img src="https://github.com/nonecap/nonecap-extension/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

A Chrome extension that solves hCaptcha challenges for you, powered by the [NoneCap](https://nonecap.com) API. Install it, browse normally, and captchas get clicked while you watch.

**Status: pre-release.** Feature complete and tested, not yet on the Chrome Web Store. You can build and load it from source today, or grab the zip from the [latest release](https://github.com/nonecap/nonecap-extension/releases).

## What it does

- 100 free solving credits per day, no account needed
- Bring your own [NoneCap API key](https://dashboard.nonecap.com) for unlimited solving
- Animated, human-like clicking inside the challenge
- Solves image grids, drag puzzles, and point-on-image challenges
- Per-site pause and a blocklist for sites where you never want it to run
- Open source under the MIT license

## Install

Chrome Web Store: coming soon. Until then, from source:

1. `bun install && bun run build`
2. Open `chrome://extensions` and enable "Developer mode"
3. Click "Load unpacked" and select the `dist` folder

Or download `nonecap-extension-v*.zip` from the [releases page](https://github.com/nonecap/nonecap-extension/releases), unzip it, and load the folder the same way.

## How it works

The extension watches for hCaptcha widgets on the page. When a challenge opens, it crops a screenshot down to just the challenge area, sends that image to the NoneCap API, and gets back coordinates to click. All recognition happens on NoneCap's servers; the extension contains no solver logic of its own.

Grid clicks and drag puzzles are dispatched as real browser input through `chrome.debugger`, because hCaptcha's canvas puzzles ignore synthetic events. The design is written up in [docs/SOLVING-ARCHITECTURE.md](docs/SOLVING-ARCHITECTURE.md).

## Permissions

The extension asks for more than most, so here is what each permission is for:

- `<all_urls>` host access: detect hCaptcha widgets on whatever site you're on and capture the challenge area there.
- `tabs`: screenshot the active tab so the challenge can be cropped out and sent for recognition.
- `debugger`: dispatch trusted mouse input. hCaptcha's drag and point puzzles ignore synthetic events from content scripts, so this is the only way to solve them. Chrome shows a "started debugging this browser" banner during a solve; the extension attaches when a solve starts and detaches when it ends.
- `storage`: keep your API key, settings, and credit balance.
- `alarms`: retry free-tier key registration if the first attempt fails.

## Privacy

The extension captures the challenge area of the screen, only while a challenge is open. It also sends an anonymous outcome ping (solved or failed, plus the round count) so solve quality can be monitored. No browsing history and no page content are collected. Full policy: [nonecap.com/extension/privacy](https://nonecap.com/extension/privacy).

## Links

- Website: [nonecap.com](https://nonecap.com)
- Dashboard and API keys: [dashboard.nonecap.com](https://dashboard.nonecap.com)

## Development

Requires [Bun](https://bun.sh).

```sh
bun install      # install dependencies
bun run dev      # vite dev server with extension hot reload
bun run build    # typecheck and build to dist/
bun run test     # run unit tests
bun run e2e      # end-to-end test (local only, see below)
bun run package  # build and zip dist/ for the store / a release
```

### End-to-end test

`bun run e2e` drives the built extension against a real hCaptcha test widget with the NoneCap API mocked locally. It never runs in CI: Chrome refuses to load unpacked MV3 extensions headlessly, so the suite opens a visible Chromium window and needs a desktop session.

One-time setup, then run:

```sh
bunx playwright install chromium   # download the Playwright Chromium build
bun run build                      # the suite loads the built dist/
bun run e2e
```

The spec starts `scripts/mock-api.ts` automatically (it scripts the recognize rounds, validates every uploaded screenshot, and journals all requests at `GET /__log`), serves `e2e/fixtures/demo.html` from a local http server, and asserts the full loop: checkbox click, challenge capture and crop, recognize round trip, action execution, and exactly one outcome ping.

The trusted-input path itself can't be covered by Playwright, since Chrome allows one debugger client per tab and Playwright already holds it. That path is covered by unit tests on the driver and coordinate math, plus manual testing on a live widget.

### Packaging

`bun run package` rebuilds and zips the contents of `dist/` into `nonecap-extension-v{version}.zip` at the repo root, with `manifest.json` at the zip root as Chrome requires. It shells out to the `zip` binary, which is preinstalled on macOS and most Linux images.

### Releases

Pushing a `v*` tag (for example `v0.1.0`) makes CI typecheck, test, package, and attach the zip to a GitHub release.

## License

MIT, see [LICENSE](LICENSE).
