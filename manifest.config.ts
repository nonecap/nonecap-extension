import { defineManifest } from '@crxjs/vite-plugin';
import { EXTENSION_VERSION } from './src/shared/version';

export default defineManifest({
  manifest_version: 3,
  name: 'NoneCap — hCaptcha Auto Solver',
  version: EXTENSION_VERSION,
  description: 'Automatically solves hCaptcha challenges in your browser using the NoneCap API.',
  minimum_chrome_version: '120',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  permissions: ['storage', 'tabs', 'alarms'],
  host_permissions: ['<all_urls>'],
  action: {
    default_popup: 'src/popup/index.html',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/page/index.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://newassets.hcaptcha.com/*'],
      js: ['src/hcaptcha/index.ts'],
      all_frames: true,
      run_at: 'document_idle',
    },
  ],
});
