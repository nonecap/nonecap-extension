# Chrome Web Store checklist

Material to prepare for the store listing and review.

## Screenshots to take (5)

1. Popup in the free tier state (daily credits remaining)
2. Popup with a NoneCap API key connected
3. Options page (settings, blocklist)
4. The status pill mid-solve on the hCaptcha demo page (https://accounts.hcaptcha.com/demo)
5. The blocked state (out of free solves, pill showing the "Add API key" prompt)

## Single purpose statement

Automatically solves hCaptcha challenges using the NoneCap API.

## Permission justifications

- `<all_urls>` (host permissions): detect hCaptcha widgets on any site the user visits and capture the challenge area there.
- `tabs`: take a screenshot of the active tab so the challenge area can be cropped and sent for recognition.
- `debugger`: dispatch trusted mouse input for hCaptcha's drag and point puzzles, which ignore synthetic events from content scripts. Attached only during an active solve.
- `storage`: store the API keys, settings, and credit balance.
- `alarms`: retry the free tier key registration when the first attempt fails.

## Privacy policy URL

https://nonecap.com/extension/privacy

## Telemetry note

The extension sends anonymous solve outcome pings (solved or failed, plus the round count) so solve quality can be monitored; no browsing history or page content is collected.
