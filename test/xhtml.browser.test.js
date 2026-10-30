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

const fetchText = async (page, url) =>
  page.evaluate(async (u) => (await (await fetch(u)).text()), url);

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
    faux.registerMatch("p[@id='para']", function (ctx) {
      return { '#p': 'xhtml-transformed: ' + ctx.node.textContent };
    });
    const node = document.getElementById('para');
    const matched = !!faux.getMatchingTemplate(node);
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
    faux.registerMatch("p[@id='para']", function (ctx) {
      return { '#p': 'same: ' + ctx.node.textContent };
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
    faux.registerMatch("p[@id='para']", function (ctx) {
      return { '#p': 'same: ' + ctx.node.textContent };
    });
    faux.transform(document.getElementById('para'));
    return document.querySelector('main > p')?.textContent;
  });

  expect(htmlOut).toBe('same: some text');
  expect(xhtmlOut).toBe('same: some text');
});

test('identity flag round-trips a subtree (XML fixture)', async ({ page }) => {
  await page.goto('/test/browser/page.html');
  await page.waitForFunction('window.__ready === true');

  // fetch the fixture text once so the comparison baseline is the
  // raw source, then transform a parsed copy with the identity flag
  const source = await fetchText(page, '/test/browser/identity.xml');
  const out = await page.evaluate((src) => {
    const xml = new DOMParser().parseFromString(
      src, 'application/xml');
    // sanity: the PI really exists in the source
    const srcPI = Array.from(xml.documentElement.childNodes)
      .some(n => n.nodeType === 7);

    const faux = new window.fauxslt.Transform(null, {
      identity: true });
    // transform() needs a node whose parent is an element, so
    // clone the document element into a wrapper and transform the
    // clone: the round trip then covers the entire fixture subtree
    const doc = xml;
    const rootEl = doc.documentElement;
    const wrap = doc.createElement('wrap');
    const clone = rootEl.cloneNode(true);
    wrap.appendChild(clone);
    doc.replaceChild(wrap, rootEl);

    const before = new XMLSerializer()
      .serializeToString(clone);

    faux.transform(clone);

    const after = new XMLSerializer()
      .serializeToString(wrap.firstChild);

    // normalize both serializations for comparison: strip
    // insignificant whitespace between tags and sort each
    // element's attributes. xmlns declarations are EXCLUDED: the
    // identity copy re-states inherited declarations on every
    // element (a documented divergence — markup-mixup binds
    // prefixes from the insertion point, so the source's in-scope
    // bindings are re-stated explicitly), so raw xmlns presence is
    // not stable across the round trip; the namespace URIs
    // themselves survive, which the normalize() below verifies
    // through element nodeName. runs in the browser (DOMParser
    // lives there)
    const normalize = (xmlText) => {
      const d = new DOMParser().parseFromString(
        xmlText, 'application/xml');
      const walk = (node, out) => {
        for (const n of node.childNodes) {
          if (n.nodeType === 1) {
            out.push('<' + n.nodeName);
            const attrs = Array.from(n.attributes || [])
              .filter(a => a.name !== 'xmlns' &&
                a.prefix !== 'xmlns')
              .map(a => [a.name, a.value])
              .sort(([a], [b]) => a.localeCompare(b));
            for (const [name, value] of attrs)
              out.push(' ' + name + '="' + value + '"');
            out.push('>');
            walk(n, out);
            out.push('</' + n.nodeName + '>');
          }
          else if (n.nodeType === 3) {
            const t = n.data.trim();
            if (t) out.push(t);
          }
          else if (n.nodeType === 7)
            out.push('<?' + n.target + ' ' + n.data + '?>');
          else if (n.nodeType === 8)
            out.push('<!--' + n.data + '-->');
        }
      };
      const out = [];
      if (d.documentElement) walk(d.documentElement, out);
      return out.join('');
    };

    // also verify the namespaced element kept its URI: nodeName
    // comparison covers the prefix, and the serialized round trip
    // carries the namespace through to the parsed document
    const afterDoc = new DOMParser().parseFromString(
      new XMLSerializer().serializeToString(wrap.firstChild),
      'application/xml');
    const nsNote = afterDoc.getElementsByTagName('x:note')[0];

    return { srcPI, before: normalize(before),
      after: normalize(after),
      nsPreserved: nsNote &&
        nsNote.namespaceURI === 'urn:fauxslt:x' };
  }, source);

  // the fixture really carried a PI (guards the vacuous case)
  expect(out.srcPI).toBe(true);

  // the round trip must reproduce the subtree: elements with
  // attributes, nested elements, mixed text, comment, and PI —
  // normalized for whitespace, attribute order, and xmlns
  // re-statement (inherited declarations are re-stated on every
  // element; the URIs themselves survive)
  expect(out.after).toBe(out.before);
  // the namespaced element kept its URI through the round trip
  expect(out.nsPreserved).toBe(true);
});

test('identity flag preserves namespace declarations in an XML document', async ({ page }) => {
  await page.goto('/test/browser/page.html');
  await page.waitForFunction('window.__ready === true');

  const out = await page.evaluate(() => {
    const xml = new DOMParser().parseFromString(
      '<w xmlns:x="urn:fauxslt:x"><r a="1"><x:tag>body</x:tag>' +
      '<plain>text</plain></r></w>', 'application/xml');
    const r = xml.querySelector('r');
    const w = r.parentNode;

    const faux = new window.fauxslt.Transform(null, {
      identity: true });
    faux.transform(r);

    // the replacement reproduces the subtree, namespaces intact
    const rt = w.querySelector('r');
    const plain = rt && rt.querySelector('plain');
    return {
      kept: !!rt,
      nsAttr: rt && rt.querySelector('x\\:tag, tag') &&
        rt.querySelector('x\\:tag, tag').namespaceURI,
      // regression: a namespace-LESS element must stay
      // namespace-less through the identity copy (markup-mixup
      // resolves the empty prefix from the insertion point and
      // would otherwise relocate it into the host document's
      // XHTML namespace)
      plainNS: plain && plain.namespaceURI,
      attr: rt && rt.getAttribute('a'),
      text: rt && rt.textContent,
    };
  });

  // the identity shallow copy re-creates the element with its
  // namespace declarations, so the namespaced child keeps its URI
  expect(out.kept).toBe(true);
  expect(out.nsAttr).toBe('urn:fauxslt:x');
  // the namespace-less element stayed namespace-less (null), not
  // XHTML
  expect(out.plainNS).toBeNull();
  expect(out.attr).toBe('1');
  expect(out.text).toContain('body');
  expect(out.text).toContain('text');
});
