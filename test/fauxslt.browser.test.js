// Browser test suite for js-fauxslt, per the README contract.
// Runs in headless Chromium against test/browser/page.html served
// over HTTP (ES modules don't load over file://).

import { test, expect } from '@playwright/test';

const go = async (page) => {
  await page.goto('/test/browser/page.html');
  await page.waitForFunction('window.__ready === true');
};

test('module imports and exposes Registry/Context in the browser', async ({ page }) => {
  await go(page);
  const api = await page.evaluate(() => ({
    ready: window.__ready,
    registry: typeof window.fauxslt.Registry,
    context: typeof window.fauxslt.Context,
  }));
  expect(api.ready).toBe(true);
  expect(api.registry).toBe('function');
  expect(api.context).toBe('function');
});

test('Registry instantiates and registers templates', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Registry();

    // registering must return something chainable (or undefined —
    // the contract doesn't promise a return; it must not throw)
    faux.registerMatch('li', function () {
      return { '#li': this.node.textContent };
    });
    faux.registerNamed('shout', function () {
      return { '#p': this.node.textContent.toUpperCase() };
    });

    return {
      templates: faux.templates.size,
      hasNamed: faux.templates instanceof Map,
    };
  });
  expect(out.templates).toBeGreaterThan(0);
  expect(out.hasNamed).toBe(true);
});

test('transform replaces the matched node with the template result', async ({ page }) => {
  await go(page);
  await page.evaluate(() => {
    const faux = new window.fauxslt.Registry();
    faux.registerMatch("p[@id='para']", function () {
      // markup-mixup spec returned from the template; carry the id
      // so the replacement stays addressable
      return { '#p': 'transformed: ' + this.node.textContent,
        id: this.node.getAttribute('id') };
    });
    window.faux = faux;
  });

  await page.evaluate(() => window.faux.transform(document.getElementById('para')));

  await expect(page.locator('#para')).toHaveText(/^transformed: some text$/);
});

test('most specific match wins: fewer nodes selected, ties to newest', async ({ page }) => {
  await go(page);
  await page.evaluate(() => {
    const faux = new window.fauxslt.Registry();
    faux.registerMatch('li', function () {
      return { '#li': 'generic ' + this.node.textContent };
    });
    faux.registerMatch('li[contains(@class, "hidden")]', function () {
      return { '#li': 'hidden ' + this.node.textContent };
    });
    window.faux2 = faux;
  });

  // the li.hidden template should win for the hidden li. note: after
  // transform() the original node is detached, so re-query by position
  const txt = await page.evaluate(() => {
    const li = document.querySelectorAll('#items li')[2];
    window.faux2.transform(li);
    return document.querySelectorAll('#items li')[2].textContent;
  });
  expect(txt).toMatch(/^hidden third$/);

  // and the generic one for the others. positional indexing again:
  // the replacement li carries no class, so class selectors drift
  const first = await page.evaluate(() => {
    window.faux2.transform(document.querySelectorAll('#items li')[0]);
    return document.querySelectorAll('#items li')[0].textContent;
  });
  expect(first).toMatch(/^generic first$/);
});

test('Context binds this.node and supports select/test', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Registry();
    let captured = null;
    faux.registerMatch("p[@id='para']", function () {
      // capture primitives only: evaluate() structured-clones the
      // return value, and DOM nodes don't survive that meaningfully
      captured = {
        isContext: this instanceof window.fauxslt.Context,
        nodeId: this.node.id,
        nodeIsPara: this.node === document.getElementById('para'),
        // select with a function call returns a number
        count: this.select('count(//li)'),
        // test on a predicate
        hasHidden: this.test('.//li[contains(@class,"hidden")]'),
      };
      return null;
    });
    faux.transform(document.getElementById('para'));
    return captured;
  });

  expect(out.isContext).toBe(true);
  expect(out.nodeId).toBe('para');
  expect(out.nodeIsPara).toBe(true);
  expect(out.count).toBe(3);
  expect(out.hasHidden).toBe(true);
});