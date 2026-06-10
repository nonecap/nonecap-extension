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
bun run test     # run tests
```

## License

MIT, see [LICENSE](LICENSE).
