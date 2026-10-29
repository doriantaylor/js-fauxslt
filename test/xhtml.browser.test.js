// XHTML browser test: the same pattern must transform a document
// parsed as XML (application/xhtml+xml) exactly like it does an HTML
// document — that uniformity is the whole point of the compile-time
// xhtml prefix rewrite.
//
// note: Chromium does not execute module scripts in XML documents
// (crbug.com/717643), so the library is injected with addScriptTag
// here. this mirrors what XHTML consumers of fauxslt will need to do
// until/unless that lands — a classic <script> also works.

import { test, expect } from '@playwright/test';

test('patterns match and transform in XHTML (XML-parsed) documents', async ({ page }) => {
  // serve the xhtml fixture as application/xhtml+xml so the browser
  // XML-parses it
  await page.route('**/test/browser/xhtml-page.html', async route => {
    const resp = await route.fetch();
    const headers = resp.headers();
    headers['content-type'] = 'application/xhtml+xml';
    await route.fulfill({ response: resp, headers });
  });

  await page.goto('/test/browser/xhtml-page.html');
  await page.addScriptTag({ type: 'module', url: '/test/browser/init.js' });
  await page.waitForFunction('window.__ready === true');

  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch("p[@id='para']", function () {
      return { '#p': 'xhtml-transformed: ' + this.node.textContent };
    });
    const node = document.getElementById('para');
    const matched = !!faux.bestMatch(node, document);
    faux.transform(node);
    return {
      contentType: document.contentType,
      matched,
      // the replacement carries no id; assert on main's first p
      result: document.querySelector('main > p')?.textContent,
    };
  });

  expect(out.contentType).toBe('application/xhtml+xml');
  expect(out.matched).toBe(true);
  expect(out.result).toBe('xhtml-transformed: some text');
});

test('HTML and XHTML transforms agree via the same pattern', async ({ page }) => {
  // HTML document
  await page.goto('/test/browser/page.html');
  await page.waitForFunction('window.__ready === true');
  const htmlOut = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch("p[@id='para']", function () {
      return { '#p': 'same: ' + this.node.textContent };
    });
    faux.transform(document.getElementById('para'));
    // the replacement carries no id; assert on main's first p
    return document.querySelector('main > p')?.textContent;
  });

  // XHTML document
  await page.route('**/test/browser/xhtml-page.html', async route => {
    const resp = await route.fetch();
    const headers = resp.headers();
    headers['content-type'] = 'application/xhtml+xml';
    await route.fulfill({ response: resp, headers });
  });
  await page.goto('/test/browser/xhtml-page.html');
  await page.addScriptTag({ type: 'module', url: '/test/browser/init.js' });
  await page.waitForFunction('window.__ready === true');
  const xhtmlOut = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch("p[@id='para']", function () {
      return { '#p': 'same: ' + this.node.textContent };
    });
    faux.transform(document.getElementById('para'));
    return document.querySelector('main > p')?.textContent;
  });

  expect(htmlOut).toBe('same: some text');
  expect(xhtmlOut).toBe('same: some text');
});
