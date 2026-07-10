<p align="center">
  <img src="public/icons/icon128.png" width="96" alt="NoneCap logo">
</p>

<h1 align="center">NoneCap hCaptcha Auto Solver</h1>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/kahepbmokpbbkfognbmimpmnlfibcolf"><img src="https://img.shields.io/chrome-web-store/v/kahepbmokpbbkfognbmimpmnlfibcolf?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store"></a>
  <a href="https://chromewebstore.google.com/detail/kahepbmokpbbkfognbmimpmnlfibcolf"><img src="https://img.shields.io/chrome-web-store/users/kahepbmokpbbkfognbmimpmnlfibcolf?label=users" alt="Chrome Web Store users"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

A Chrome extension that solves hCaptcha challenges for you, powered by the [NoneCap](https://nonecap.com) API. Install it, browse normally, and captchas get clicked while you watch.

## Install

**[Add to Chrome from the Chrome Web Store →](https://chromewebstore.google.com/detail/kahepbmokpbbkfognbmimpmnlfibcolf)**

That's it — pin the extension, and it starts detecting and solving hCaptcha as you browse.

## Source availability

To protect against abuse and to preserve our edge, the extension's source code is
not published in this repository. Download the packaged, ready-to-load build from
the [latest release](https://github.com/nonecap/nonecap-extension/releases) instead.

All captcha recognition runs on NoneCap's servers — the extension itself contains
no solver logic, so the packaged build is everything you need to run it.

## What it does

- 100 free solving credits per day, no account needed
- Bring your own [NoneCap API key](https://dashboard.nonecap.com) for unlimited solving
- Animated, human-like clicking inside the challenge
- Solves image grids, drag puzzles, and point-on-image challenges
- Per-site pause and a blocklist for sites where you never want it to run
- Provisioning support for automation setups that use a fresh browser profile per run

## Install unpacked (optional)

Prefer to load it manually? Download `nonecap-extension-v*.zip` from the
[releases page](https://github.com/nonecap/nonecap-extension/releases), then:

1. Unzip it
2. Open `chrome://extensions` and enable "Developer mode"
3. Click "Load unpacked" and select the unzipped folder

## Automation / fresh browser profiles

If you run the extension in an automation tool that launches a fresh browser profile per run, your API key won't survive between runs — it lives in per-profile extension storage. Pre-seed it with either channel (requires v0.3.3+):

**Option 1 — `provision.json`** (unpacked installs): after unzipping, create a `provision.json` next to `manifest.json` (the zip includes a `provision.example.json` to copy):

```json
{ "key": "nc_live_yourkeyhere" }
```

You can also pre-configure settings:

```json
{
  "key": "nc_live_yourkeyhere",
  "settings": { "style": "fast", "showOverlay": false, "blocklist": ["example.com"] }
}
```

The file is read when the extension starts. A malformed key rejects the whole file; unknown or mistyped settings fields are ignored.

**Option 2 — provision URL** (any install, including Web Store): navigate the profile to

```
https://nonecap.com/ext/provision#nc_live_yourkeyhere
```

The key travels in the URL fragment, which never leaves the browser. A JSON payload like the one above works in the fragment too. Wait for the `#nonecap-provision-result[data-ok="true"]` element (or the page title `NoneCap provisioned`) before continuing, e.g. with Puppeteer:

```js
await page.goto('https://nonecap.com/ext/provision#' + apiKey);
await page.waitForSelector('#nonecap-provision-result[data-ok="true"]');
```

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

- Chrome Web Store: [NoneCap — hCaptcha Auto Solver](https://chromewebstore.google.com/detail/kahepbmokpbbkfognbmimpmnlfibcolf)
- Website: [nonecap.com](https://nonecap.com)
- Dashboard and API keys: [dashboard.nonecap.com](https://dashboard.nonecap.com)
