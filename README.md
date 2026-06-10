# NoneCap hCaptcha auto solver

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Chrome extension that automatically solves hCaptcha challenges using the [NoneCap](https://nonecap.com) API. Install it, browse normally, and captchas get clicked for you.

**Status: pre-release.** Under active development, not yet on the Chrome Web Store. The scaffold builds and loads, but the solving features below are still being implemented.

## What it will do

- 100 free solving credits per day, no account needed
- Bring your own NoneCap API key for unlimited solving
- Animated, human-like clicking inside the challenge
- Per-site pause and a blocklist for sites where you never want it to run
- Open source under the MIT license

## Install

- Chrome Web Store: coming soon
- From source (developer mode):
  1. `bun install && bun run build`
  2. Open `chrome://extensions`, enable "Developer mode"
  3. Click "Load unpacked" and select the `dist` folder

## How it works

The extension detects hCaptcha widgets on the page. When a challenge appears, it sends a cropped screenshot of just the challenge area to the NoneCap API and the API responds with where to click. All solving happens on NoneCap's servers, so there is no solver logic in the extension itself.

## Privacy

The extension only captures the challenge area of the screen, and only while a challenge is open. Nothing else is collected. Read the full privacy policy at [nonecap.com/extension/privacy](https://nonecap.com/extension/privacy).

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

`bun run e2e` drives the built extension against a real hCaptcha test widget with the NoneCap API mocked locally. It is local only and never runs in CI: Chrome refuses to load unpacked MV3 extensions in headless mode, so the suite opens a visible (headed) Chromium window and needs a desktop session.

One-time setup, then run:

```sh
bunx playwright install chromium   # download the Playwright Chromium build
bun run build                      # the suite loads the built dist/
bun run e2e
```

The spec starts `scripts/mock-api.ts` automatically (it scripts the recognize rounds, validates every uploaded screenshot and journals all requests at `GET /__log`), serves `e2e/fixtures/demo.html` from a local http server, and asserts the full loop: checkbox click, challenge capture and crop, recognize round trip, action execution, and exactly one outcome ping.

### Packaging

`bun run package` rebuilds and zips the contents of `dist/` into `nonecap-extension-v{version}.zip` at the repo root, with `manifest.json` at the zip root as Chrome requires. It shells out to the `zip` binary, which is preinstalled on macOS and most Linux images.

### Releases

Pushing a `v*` tag (for example `v0.1.0`) makes CI typecheck, test, package, and attach the zip to a GitHub release automatically.

## Chrome Web Store checklist

Material to prepare for the store listing and review.

**Screenshots to take (5):**

1. Popup in the free tier state (daily credits remaining)
2. Popup with a NoneCap API key connected
3. Options page (settings, blocklist)
4. The status pill mid-solve on the hCaptcha demo page (https://accounts.hcaptcha.com/demo)
5. The blocked state (out of free solves, pill showing the "Add API key" prompt)

**Single purpose statement:**

Automatically solves hCaptcha challenges using the NoneCap API.

**Permission justifications:**

- `<all_urls>` (host permissions): detect hCaptcha widgets on any site the user visits and capture the challenge area there.
- `tabs`: take a screenshot of the active tab so the challenge area can be cropped and sent for recognition.
- `storage`: store the API keys, settings, and credit balance.
- `alarms`: retry the free tier key registration when the first attempt fails.

**Privacy policy URL:** https://nonecap.com/extension/privacy

**Telemetry note:** the extension sends anonymous solve outcome pings (solved or failed, plus the round count) so solve quality can be monitored; no browsing history or page content is collected.

## License

MIT, see [LICENSE](LICENSE).
