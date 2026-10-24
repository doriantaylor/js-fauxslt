// Playwright config for js-fauxslt browser tests.
//
// fauxslt targets the browser: its modules are imported over HTTP
// into real pages, and the tests exercise transformations against a
// live DOM in headless Chromium. serve provides the static root so
// ES module imports resolve.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  baseURL: 'http://localhost:3721',

  // fauxslt is not a cross-browser matrix project (yet); one modern
  // engine faithfully reflects the deployment target
  projects: [{
    name: 'chromium',
    use: { browserName: 'chromium', baseURL: 'http://localhost:3721' },
  }],

  webServer: {
    command: 'pnpm exec serve -l 3721 .',
    url: 'http://localhost:3721',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});