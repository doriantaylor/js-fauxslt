// Browser test suite for js-fauxslt, per the README contract.
// Runs in headless Chromium against test/browser/page.html served
// over HTTP (ES modules don't load over file://).

import { test, expect } from '@playwright/test';

const go = async (page) => {
  await page.goto('/test/browser/page.html');
  await page.waitForFunction('window.__ready === true');
};

test('module imports and exposes Transform/Context in the browser', async ({ page }) => {
  await go(page);
  const api = await page.evaluate(() => ({
    ready: window.__ready,
    registry: typeof window.fauxslt.Transform,
    context: typeof window.fauxslt.Context,
  }));
  expect(api.ready).toBe(true);
  expect(api.registry).toBe('function');
  expect(api.context).toBe('function');
});

test('Transform instantiates and registers templates', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();

    // registering must return something chainable (or undefined —
    // the contract doesn't promise a return; it must not throw)
    faux.registerMatch('li', function (ctx) {
      return { '#li': ctx.node.textContent };
    });
    faux.registerNamed('shout', function (ctx) {
      return { '#p': ctx.node.textContent.toUpperCase() };
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
    const faux = new window.fauxslt.Transform();
    faux.registerMatch("p[@id='para']", function (ctx) {
      // markup-mixup spec returned from the template; carry the id
      // so the replacement stays addressable
      return { '#p': 'transformed: ' + ctx.node.textContent,
        id: ctx.node.getAttribute('id') };
    });
    window.faux = faux;
  });

  await page.evaluate(() => window.faux.transform(document.getElementById('para')));

  await expect(page.locator('#para')).toHaveText(/^transformed: some text$/);
});

test('most specific match wins: fewer nodes selected, ties to newest', async ({ page }) => {
  await go(page);
  await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch('li', function (ctx) {
      return { '#li': 'generic ' + ctx.node.textContent };
    });
    faux.registerMatch('li[contains(@class, "hidden")]', function (ctx) {
      return { '#li': 'hidden ' + ctx.node.textContent };
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

test('Context receives node and select/test', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    let captured = null;
    faux.registerMatch("p[@id='para']", function (ctx) {
      // capture primitives only: evaluate() structured-clones the
      // return value, and DOM nodes don't survive that meaningfully
      captured = {
        isContext: ctx instanceof window.fauxslt.Context,
        nodeId: ctx.node.id,
        nodeIsPara: ctx.node === document.getElementById('para'),
        // select with a function call returns a number
        count: ctx.select('count(//li)'),
        // test on a predicate
        hasHidden: ctx.test('.//li[contains(@class,"hidden")]'),
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

test('nested spec callbacks receive the Context', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    let captured = {};
    faux.registerMatch("p[@id='para']", function (ctx) {
      captured.topLevelIsContext = ctx instanceof window.fauxslt.Context;
      // nested markup-mixup callbacks receive the Context as first
      // argument (and as `this` for plain functions)
      return { '#span': [
        (nctx) => {
          captured.nestedIsContext =
            nctx instanceof window.fauxslt.Context;
          return 'body';
        },
      ], class: function () {
        // markup-mixup hands attribute callbacks the Context as
        // `this` (their argument is the raw args array)
        return 'bound-' + (this instanceof window.fauxslt.Context);
      } };
    });
    faux.transform(document.getElementById('para'));
    const span = document.querySelector('main span');
    return { ...captured,
      spanExists: !!span,
      spanClass: span && span.getAttribute('class') };
  });

  expect(out.topLevelIsContext).toBe(true);
  expect(out.nestedIsContext).toBe(true);
  expect(out.spanExists).toBe(true);
  expect(out.spanClass).toBe('bound-true');
});

test('params propagate and merge most-specific-wins', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    faux.registerMatch("ul[@id='items']", function (ctx) {
      // push our params object by reference: children are minted
      // during the call (each with its own copy), so mutating ours
      // afterwards must not reach theirs
      seen.push(ctx.params);
      const kids = ctx.applyTemplates('li');
      ctx.params.marker = 'mutated';
      return kids;
    });
    faux.registerMatch('li', function (ctx) {
      seen.push(ctx.params);
      return null;
    });
    faux.transform(document.getElementById('items'),
      { greeting: 'hello', depth: 'top' });

    return {
      parent: { marker: seen[0].marker },
      children: seen.slice(1).map(p => ({ marker: p.marker })),
    };
  });

  // children were minted before the parent's mutation, each holding
  // its own (shallow) copy: the mutation must not reach them
  expect(out.children.length).toBe(3);
  expect(out.parent.marker).toBe('mutated');
  for (const c of out.children) expect(c.marker).toBeUndefined();
});

test('applyTemplates params override the parent context params', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    faux.registerMatch("ul[@id='items']", function (ctx) {
      return ctx.applyTemplates('li', { depth: 'child' });
    });
    faux.registerMatch('li', function (ctx) {
      seen.push(ctx.params);
      return null;
    });
    faux.transform(document.getElementById('items'),
      { depth: 'top', extra: 'kept' });
    return seen.map(p => ({ depth: p.depth, extra: p.extra }));
  });

  expect(out.length).toBe(3);
  for (const c of out) {
    expect(c.depth).toBe('child');   // applyTemplates params win
    expect(c.extra).toBe('kept');   // but siblings pass through
  }
});

test('callTemplate mints a fresh context with merged params', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    faux.registerMatch("ul[@id='items']", function (ctx) {
      seen.push(ctx.params);
      return ctx.callTemplate('shim', { via: 'call' });
    });
    faux.registerNamed('shim', function (ctx) {
      seen.push(ctx.params);
      return { '#b': 'shim:' + ctx.params.greeting +
        ':' + ctx.params.via };
    });
    const top = document.createElement('main');
    const items = document.createElement('ul');
    items.id = 'items';
    const li = document.createElement('li');
    items.appendChild(li);
    top.appendChild(items);
    document.body.appendChild(top);
    faux.transform(items, { greeting: 'hi' });
    // transform() replaces the ul itself, so the shim's <b> lands
    // directly under main
    const b = document.querySelector('main > b');
    return {
      text: b && b.textContent,
      topParams: { greeting: seen[0].greeting, via: seen[0].via },
      namedParams: { greeting: seen[1].greeting, via: seen[1].via },
    };
  });

  expect(out.text).toBe('shim:hi:call');
  expect(out.topParams.greeting).toBe('hi');
  expect(out.topParams.via).toBeUndefined();
  expect(out.namedParams.greeting).toBe('hi');  // pass-through
  expect(out.namedParams.via).toBe('call');     // explicit params win
});