// Uniformity spec for the README transform example: the operator's
// transform fixtures (HTML and XML-parsed XHTML legs), asserted to
// produce IDENTICAL output — h1 with the title text, the `draft`
// class, the main → article-shim fallback, and the footer. This is
// the end-to-end proof of the `_` default-namespace convention.
//
// Also carries the Phase 0 platform probe: the fact that the
// native XPathEvaluator is never consulted for the EMPTY prefix
// (operator-verified empirically in Firefox and Chromium against an
// XML-parsed XHTML page) — the platform fact the rewrite design
// rests on — pinned in-repo as a test.

import { test, expect } from '@playwright/test';

// assertions shared by both legs: the body replacement with header
// (h1 holding the title text), draft class, the main → article-shim
// fallback (a fresh <main> wrapping a fresh <article> holding the
// body text — the fixture's source had neither), and footer
const assertTransformed = (out) => {
  expect(out.h1).toBe('FauXSLT lol');
  expect(out.draft).toBe(true);
  // the fixture body's indentation rides the copied text nodes
  expect(out.articleText.trim()).toBe('sup doggs');
  expect(out.footer).toBe('copyright 2026 lol');
  // the shim fallback produced main > article; the applyTemplates
  // null-on-empty made it reachable (an empty array would be truthy
  // and defeat the || fallback)
  expect(out.mainWrapped).toBe(true);
};

test('Phase 0 probe: the resolver is never consulted for the empty prefix', async ({ page }) => {
  // (a) XHTML side: on an XML-parsed XHTML document, `//title`
  // through document.createExpression with a resolver binding the
  // EMPTY prefix to XHTML nets NOTHING, while the prefixed form
  // nets the title — the load-bearing fact behind the rewrite
  // design (operator-verified in Firefox and Chromium).
  await page.route('**/test/browser/xhtml-page.html', async route => {
    const resp = await route.fetch();
    const headers = resp.headers();
    headers['content-type'] = 'application/xhtml+xml';
    await route.fulfill({ response: resp, headers });
  });
  await page.goto('/test/browser/xhtml-page.html');

  const xhtmlOut = await page.evaluate(() => {
    const resolve = (prefix) =>
      prefix === '' ? 'http://www.w3.org/1999/xhtml' : null;
    const doc = document;
    const empty = doc.createExpression('//title', resolve)
      .evaluate(doc, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    const prefixed = doc.createExpression('//html:title',
      (p) => p === 'html' ? 'http://www.w3.org/1999/xhtml' : null)
      .evaluate(doc, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    return { empty: empty.snapshotLength,
      prefixed: prefixed.snapshotLength,
      contentType: doc.contentType };
  });

  expect(xhtmlOut.contentType).toBe('application/xhtml+xml');
  expect(xhtmlOut.empty).toBe(0);
  expect(xhtmlOut.prefixed).toBe(1);

  // (b) HTML side: on page.html, `count(//li)` nets 3 NATIVELY with
  // a null resolver — the load-bearing claim behind the
  // no-rewrite-when-no-default-namespace leg (unprefixed names
  // match namespace-less elements, which is what the HTML DOM
  // reports). plus: a text/html document whose root carries an
  // explicit xmlns="http://www.w3.org/1999/xhtml" (the polyglot
  // edge) — the DOM preserves the raw attribute, so
  // defaultNamespaceURI reads it and the document classifies as
  // default-namespaced (rewritten), unlike its xmlns-less sibling.
  await page.goto('/test/browser/page.html');
  const htmlOut = await page.evaluate(() => {
    const doc = document;
    const count = doc.createExpression('count(//li)', null)
      .evaluate(doc, XPathResult.NUMBER_TYPE).numberValue;

    // polyglot edge: same markup, parsed as text/html, WITH an
    // explicit xmlns on the root. createElement keeps the HTML
    // namespace-lessness, so //li nets nothing through the
    // HTML-namespaced resolver — but the raw attribute is what
    // defaultNamespaceURI reads, pinning the classification
    const probe = document.implementation.createHTMLDocument('');
    probe.documentElement.setAttribute(
      'xmlns', 'http://www.w3.org/1999/xhtml');
    probe.body.innerHTML = '<ul><li>one</li><li>two</li></ul>';
    const rawAttr = probe.documentElement
      .getAttribute('xmlns');
    const liNS = probe.querySelector('li') &&
      probe.querySelector('li').namespaceURI;

    return { count, rawAttr, liNS,
      pageRootRaw: doc.documentElement.getAttribute('xmlns') };
  });

  expect(htmlOut.count).toBe(3);
  expect(htmlOut.pageRootRaw).toBeNull();
  expect(htmlOut.rawAttr).toBe('http://www.w3.org/1999/xhtml');
  // DOM fact: elements of a text/html document carry the XHTML
  // namespaceURI regardless of any xmlns attribute — so the
  // default-namespaced classification (and the `_:name` rewrite)
  // rests on the RAW ATTRIBUTE, not namespaceURI. either way the
  // names match: natively via the engine's HTML accommodation when
  // unrewritten, and through the XHTML-resolved `_:name` when not
  expect(htmlOut.liNS).toBe('http://www.w3.org/1999/xhtml');
});

test('the README example transform produces identical output in HTML', async ({ page }) => {
  // the HTML fixture loads transform-test.js at module load
  // through its own (repaired) import map and module script
  await page.goto('/test/browser/transform-html.html');
  await page.waitForFunction('window.__transformed === true');

  const out = await page.evaluate(() => ({
    h1: document.querySelector('body > header h1')?.textContent,
    draft: document.body.classList.contains('draft'),
    mainWrapped: !!document.querySelector('body main article'),
    articleText: document.querySelector('body article')?.textContent,
    footer: document.querySelector('body footer')?.textContent,
  }));
  assertTransformed(out);
});

test('the README example transform produces identical output in XHTML', async ({ page }) => {
  // serve the XHTML fixture as application/xhtml+xml so the
  // browser XML-parses it. Chromium does not execute module
  // scripts in XML documents (crbug.com/717643), so the spec
  // injects the import map and the module programmatically —
  // NOT relying on the fixture's inline tags
  await page.route('**/test/browser/transform-xhtml.xhtml',
    async route => {
      const resp = await route.fetch();
      const headers = resp.headers();
      headers['content-type'] = 'application/xhtml+xml';
      await route.fulfill({ response: resp, headers });
    });
  await page.goto('/test/browser/transform-xhtml.xhtml');

  // inject the import map BEFORE the module: injected module
  // scripts resolve bare specifiers through the document's import
  // map, and the map must be present when the module's imports
  // resolve
  await page.addScriptTag({ type: 'importmap', content:
    JSON.stringify({ imports: {
      'fauxslt': '/dist/fauxslt.js',
      'markup-mixup': '/node_modules/markup-mixup/markup-mixup.js',
    } }) });
  await page.addScriptTag({ type: 'module',
    url: '/test/browser/transform-test.js' });
  await page.waitForFunction('window.__transformed === true');

  const out = await page.evaluate(() => ({
    contentType: document.contentType,
    h1: document.querySelector('body > header h1')?.textContent,
    draft: document.body.classList.contains('draft'),
    mainWrapped: !!document.querySelector('body main article'),
    articleText: document.querySelector('body article')?.textContent,
    footer: document.querySelector('body footer')?.textContent,
  }));
  expect(out.contentType).toBe('application/xhtml+xml');
  assertTransformed(out);
});