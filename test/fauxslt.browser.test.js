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

    // the §5.8 built-ins are present in the registry before any
    // user registration, as ordinary templates in the default mode
    const builtin = ['*', '/', 'text()', 'comment()',
      'processing-instruction()'];

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
      builtins: builtin.map(p =>
        faux.templates.has(p) && faux.templates.get(p).has(null)),
    };
  });
  expect(out.templates).toBeGreaterThan(0);
  expect(out.hasNamed).toBe(true);
  // every built-in present in the default mode before user code
  for (const b of out.builtins) expect(b).toBe(true);
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

test('most specific match wins: predicated over bare, built-ins never', async ({ page }) => {
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
  // the replacement li carries no class, so class selectors drift.
  // the built-in * (priority −0.5) never beats either user template
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
test('getMatchingTemplates returns matches sorted by priority', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch('li', function () { return null; });            // 0
    faux.registerMatch('li[contains(@class, "item")]',                   // 0.5
      function () { return null; });
    faux.registerMatch('*', function () { return null; });               // -0.5
    const li = document.querySelectorAll('#items li')[0];
    const ts = faux.getMatchingTemplates(li);
    return {
      count: ts.length,
      priorities: ts.map(t => t.getPriority()),
      best: faux.getMatchingTemplate(li) === ts[0],
      none: faux.getMatchingTemplate(document.querySelector('#para')) &&
        document.querySelector('#para').nodeType,
    };
  });

  expect(out.count).toBe(3);
  expect(out.priorities).toEqual([0.5, 0, -0.5]);
  expect(out.best).toBe(true);
});

test('modes partition templates: strict matching, inheritance, override', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];

    // default-mode template for li
    faux.registerMatch('li', function (ctx) {
      seen.push('default:' + ctx.mode);
      return { '#li': 'd ' + ctx.node.textContent };
    });
    // toc-mode template for li (higher priority: has a predicate)
    faux.registerMatch('li', function (ctx) {
      seen.push('toc:' + ctx.mode);
      return { '#li': 't ' + ctx.node.textContent };
    }, 'toc');

    // default mode: the default template applies
    faux.transform(document.querySelectorAll('#items li')[0]);
    // toc mode: only the toc template applies (strict: no fallback)
    faux.transform(document.querySelectorAll('#items li')[1], null, 'toc');

    // a node with no template in a mode recurses into children per
    // the no-match fallback (claimed descendants fire; unclaimed
    // text drops). the para has no element children: after the
    // fallback recurses into its text and drops it, the para is
    // gone entirely (empty result = drop)
    const paraGone = (() => {
      const p = document.getElementById('para');
      faux.transform(p, null, 'toc');
      return document.getElementById('para') === null;
    })();

    // mode override through applyTemplates: the ul template is
    // registered IN toc mode, so it runs and its applyTemplates
    // inherits toc
    const inner = new window.fauxslt.Transform();
    const innerSeen = [];
    inner.registerMatch('ul', function (ctx) {
      return ctx.applyTemplates('li');
    }, 'toc');
    inner.registerMatch('li', function (ctx) {
      innerSeen.push(ctx.mode);
      return { '#li': 'd' };
    });
    inner.registerMatch('li', function (ctx) {
      innerSeen.push(ctx.mode);
      return { '#li': 't' };
    }, 'toc');
    inner.transform(document.getElementById('items'), null, 'toc');

    return { seen, paraGone, innerSeen };
  });

  // transform() mode reaches the matched template
  expect(out.seen).toEqual(['default:null', 'toc:toc']);
  // no match in mode → the fallback recurses and drops; with no
  // claimable children the para vanishes entirely (empty = drop)
  expect(out.paraGone).toBe(true);
  // applyTemplates inherits the active mode
  expect(out.innerSeen).toEqual(['toc', 'toc', 'toc']);
});

test('registerMatch accepts options and positional mode/priority/name', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const modes = [];
    // options form
    faux.registerMatch('li', function (ctx) {
      modes.push(ctx.mode); return null;
    }, { mode: 'opts', priority: 2, name: 'optshim' });
    // positional form: mode then priority
    faux.registerMatch('p', function (ctx) {
      modes.push(ctx.mode); return null;
    }, 'pos', 1);
    const byName = faux.named.get('optshim');

    return {
      named: !!byName,
      namedPriority: byName && byName.getPriority(),
      count: faux.templates.size,
    };
  });
  // options form registered the name alongside the pattern
  expect(out.named).toBe(true);
  expect(out.namedPriority).toBe(2);
});

test('ctx.getAttributes returns the current node attribute map', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    let attrs = null;
    faux.registerMatch('li[contains(@class, "hidden")]', function (ctx) {
      attrs = ctx.getAttributes();
      // spread the attribute map into a spec
      return Object.assign({ '#li': ctx.node.textContent }, attrs);
    });
    faux.transform(document.querySelectorAll('#items li')[2]);
    const li = document.querySelectorAll('#items li')[2];
    return { attrs, replaced: li.getAttribute('class') };
  });

  expect(out.attrs).toEqual({ class: 'item hidden' });
  expect(out.replaced).toBe('item hidden');
});

test('ctx.document fetches, parses, and caches external XML', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(async () => {
    const faux = new window.fauxslt.Transform();
    let doc1 = null, doc2 = null, cached = false;
    faux.registerMatch("p[@id='para']", function (ctx) {
      doc1 = ctx.document('/test/browser/fixture.xml');
      doc2 = ctx.document('/test/browser/fixture.xml');
      cached = doc1 === doc2;
      return null;
    });
    faux.transform(document.getElementById('para'));
    return {
      cached,
      root: doc1 && doc1.documentElement.tagName,
      title: doc1 && doc1.querySelector('title') &&
        doc1.querySelector('title').textContent,
    };
  });

  expect(out.cached).toBe(true);
  expect(out.root).toBe('fixture');
  expect(out.title).toBe('a fixture document');
});

test('built-in element rule recurses into children; attributes drop', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    // transform the ul: unclaimed by any user template, so the
    // built-in * fires — recursion into children, not deep copy.
    // the ul's attributes (id, class) drop per §5.8, and the li
    // children — also unclaimed — recurse down to their text,
    // which the built-in text rule copies. the ul is replaced by
    // bare text (its grandchildren content)
    const ul = document.getElementById('items');
    const parent = ul.parentNode;
    faux.transform(ul);
    return {
      // the ul itself is gone: replaced by its processed children
      ulGone: !document.getElementById('items'),
      // no li elements survive the §5.8 recursion (each li was
      // itself replaced by its copied text)
      lis: parent.querySelectorAll('li').length,
      // the text content came through
      text: parent.textContent,
    };
  });
  // the ul is replaced by its children (no template claimed it)
  expect(out.ulGone).toBe(true);
  // each unclaimed li likewise collapsed to its copied text
  expect(out.lis).toBe(0);
  expect(out.text).toContain('first');
  expect(out.text).toContain('second');
  expect(out.text).toContain('third');
});

test('text is copied and comments dropped by the built-ins; user text() overrides', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    // XML-parsed fixture so comments survive; wrapped in an outer
    // element because transforming a node whose parent is the
    // document is unsupported (markup-mixup's replace needs an
    // element parent for text results)
    const xml = new DOMParser().parseFromString(
      '<w><r><p>alpha</p><!-- a comment --><p>beta</p></r></w>',
      'application/xml');
    const r = xml.querySelector('r');
    const w = r.parentNode;

    const faux = new window.fauxslt.Transform();
    // r is unclaimed: built-in * recurses; p elements likewise;
    // text copied; comment dropped
    faux.transform(r);
    const after = Array.from(w.childNodes)
      .map(n => n.nodeType === 8 ? 'comment:' + n.data :
        n.nodeType === 3 ? n.data : 'other:' + n.nodeType);

    // user override: re-registering text() replaces the built-in
    const faux2 = new window.fauxslt.Transform();
    const seen = [];
    faux2.registerMatch('text()', function (ctx) {
      seen.push(ctx.node.data);
      return ctx.node.data.toUpperCase();
    });
    const xml2 = new DOMParser().parseFromString(
      '<w><r>alpha<b>beta</b>gamma</r></w>', 'application/xml');
    const r2 = xml2.querySelector('r');
    const w2 = r2.parentNode;
    faux2.transform(r2);
    const out2 = Array.from(w2.childNodes)
      .map(n => n.nodeType === 3 ? n.data : n.textContent);

    return { after, seen, out2 };
  });

  // built-in text rule copied the strings; the built-in comment
  // rule dropped the comment
  expect(out.after).toEqual(['alpha', 'beta']);
  // the user text() override fired on every text node — including
  // the one inside <b>, which the built-in * rule recursed into
  expect(out.seen.sort()).toEqual(['alpha', 'beta', 'gamma']);
  expect(out.out2).toEqual(['ALPHA', 'BETA', 'GAMMA']);
});

test('processing-instructions are dropped in default mode (XML fixture)', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    // PIs only exist in XML-parsed documents: HTML parsing destroys
    // them, so an HTML-fixture assertion would be vacuous
    const xml = new DOMParser().parseFromString(
      '<?xml-stylesheet type="text/xsl" href="x"?><w><r><p>keep</p>' +
      '<?ping data?>text</r></w>', 'application/xml');
    // assert the PI exists in the source before transforming (PIs
    // are not elements; scan the child nodes)
    const r = xml.querySelector('r');
    const srcPI = Array.from(r.childNodes)
      .some(n => n.nodeType === 7);
    const w = r.parentNode;

    const faux = new window.fauxslt.Transform();
    // r is unclaimed: built-in * recurses; the child PI hits the
    // built-in processing-instruction() rule and drops. the p
    // element is also unclaimed: it collapses to its copied text
    faux.transform(r);
    const piGone = !Array.from(w.childNodes)
      .some(n => n.nodeType === 7);
    // no p element survives the recursion, but its text does
    const textContent = Array.from(w.childNodes)
      .filter(n => n.nodeType === 3).map(n => n.data);

    return { srcPI, piGone, textContent };
  });

  // the source really had a PI (guards the vacuous case)
  expect(out.srcPI).toBe(true);
  // the built-in processing-instruction rule dropped it
  expect(out.piGone).toBe(true);
  // the p's text survived; the PI's did not
  expect(out.textContent).toEqual(['keep', 'text']);
});

test('user templates beat built-ins by §5.5 priority; * overwrites the built-in', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    // bare-name user template (priority 0) beats the built-in *
    // (−0.5) on li nodes
    faux.registerMatch('li', function (ctx) {
      return { '#li': 'user ' + ctx.node.textContent };
    });
    faux.transform(document.querySelectorAll('#items li')[0]);
    const userWon = document.querySelectorAll('#items li')[0]
      .textContent === 'user first';

    // re-registering * replaces the built-in (same pattern+mode
    // overwrite): attributes now preserved and no recursion
    const faux2 = new window.fauxslt.Transform();
    faux2.registerMatch('*', function (ctx) {
      return Object.assign({ '#li': ctx.node.textContent },
        ctx.getAttributes());
    });
    faux2.transform(document.querySelectorAll('#items li')[1]);
    const li = document.querySelectorAll('#items li')[1];
    const overwritten = li.tagName === 'LI' &&
      li.getAttribute('class') === 'item' &&
      li.textContent === 'second';

    // wildcard-equivalent node() (−0.5) does NOT beat the built-in *
    // (−0.5, first-registered): the built-in still fires, so the li
    // collapses to its text with attributes dropped
    const faux3 = new window.fauxslt.Transform();
    faux3.registerMatch('node()', function (ctx) {
      return { '#span': 'node() fired' };
    });
    const third = document.querySelectorAll('#items li')[2];
    const p3 = third.parentNode;
    faux3.transform(third);
    const nodeLost = !p3.querySelector('span') &&
      p3.textContent.includes('third');

    return { userWon, overwritten, nodeLost };
  });

  expect(out.userWon).toBe(true);
  expect(out.overwritten).toBe(true);
  expect(out.nodeLost).toBe(true);
});

test('positional predicates match: li[2] nets only the second li', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    // second: li[2] (and only li[2]) gets marked; everything else
    // falls through to the built-ins
    faux.registerMatch('li[2]', function (ctx) {
      seen.push(ctx.node.textContent);
      return { '#li': 'marked ' + ctx.node.textContent };
    });
    // transform the ul ONCE: the engine nets every li through the
    // parent-as-context scan, so li[2] matches only the second li
    const ul = document.getElementById('items');
    const parent = ul.parentNode;
    faux.transform(ul);
    return { seen,
      marked: parent.querySelectorAll('li').length === 1 &&
        parent.querySelector('li').textContent };
  });
  // pins the latent positional-predicate fix: under the old
  // boolean scan li[2] never matched; under parent-as-context it
  // nets the second li child of each parent
  expect(out.seen).toEqual(['second']);
  expect(out.marked).toBe('marked second');
});

test('predicated node tests evaluate: text()[normalize-space(.)]', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    faux.registerMatch(
      "text()[normalize-space(.)='alpha']",
      function (ctx) {
        seen.push(ctx.node.data);
        return null;
      });
    // wrapped: transform() replaces the node, which needs an
    // element parent for text results
    const xml = new DOMParser().parseFromString(
      '<w><r><p>alpha</p><p>beta</p></r></w>', 'application/xml');
    const r = xml.querySelector('r');
    const w = r.parentNode;
    try {
      // r is unclaimed: built-in * recurses into p, then text;
      // the predicated text() template claims the matching node
      faux.transform(r);
      return { threw: false, seen,
        alphaGone: !w.textContent.includes('alpha'),
        betaKept: w.textContent.includes('beta') };
    }
    catch (e) {
      // a registration-time probe is not implemented; if Chromium
      // refuses the predicate-internal context, it throws loudly
      // at first evaluation — the documented restriction
      return { threw: true, name: e.name, msg: String(e.message) };
    }
  });

  // the predicated node test works natively (predicate-internal
  // contexts are distinct from the top-level contextNode
  // restriction); if it ever throws, this test surfaces the
  // documented restriction instead of failing silently
  expect(out.threw).toBe(false);
  expect(out.seen).toEqual(['alpha']);
  // the claimed text node dropped (template returned null);
  // beta survived via the built-in text rule
  expect(out.alphaGone).toBe(true);
  expect(out.betaKept).toBe(true);
});

test('non-default modes have no built-ins; fallback recurses and drops text', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    const seen = [];
    // a toc-mode template on the li descendants of an
    // otherwise-unclaimed element
    faux.registerMatch('li', function (ctx) {
      seen.push(ctx.node.textContent);
      return { '#li': 't ' + ctx.node.textContent };
    }, 'toc');

    // transform the ul in toc mode: no toc-mode template for ul, so
    // the fallback recurses into children; the li fires inside it
    const ul = document.getElementById('items');
    const parent = ul.parentNode;
    faux.transform(ul, null, 'toc');
    const lis = parent.querySelectorAll('li');

    // unclaimed text in a mode with no built-in text(): dropped.
    // wrapped: transform() replaces the node, which needs an
    // element parent
    const xml = new DOMParser().parseFromString(
      '<w><r>only text</r></w>', 'application/xml');
    const r = xml.querySelector('r');
    const w = r.parentNode;
    const faux2 = new window.fauxslt.Transform();
    faux2.transform(r, null, 'toc');
    const textDropped = w.childNodes.length === 0;

    return { seen, lis: lis.length,
      liText: lis[0] && lis[0].textContent, textDropped };
  });

  // the claimed descendants fired through the fallback recursion
  expect(out.seen).toEqual(['first', 'second', 'third']);
  expect(out.lis).toBe(3);
  expect(out.liText).toBe('t first');
  // unclaimed text in a mode with no built-in text(): dropped
  expect(out.textDropped).toBe(true);
});

test('an element whose every child drops is itself dropped', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    // regression: a body returning an EMPTY array — exactly what
    // the built-in * body returns over a sole comment/PI/childless
    // element — must net nothing, not [[]]
    const results = {};
    for (const [label, inner] of [
      ['sole comment', '<!-- c -->'],
      ['sole PI', '<?pi data?>'],
      ['childless element', ''],
    ]) {
      const xml = new DOMParser().parseFromString(
        '<w><r>' + inner + '</r></w>', 'application/xml');
      const r = xml.querySelector('r');
      const w = r.parentNode;
      const faux = new window.fauxslt.Transform();
      faux.transform(r);
      results[label] = w.childNodes.length === 0;
    }

    // a user body returning [] (an HTML li, where the bare-name
    // pattern actually matches): the ul is replaced by nothing —
    // every li nets [] and the spread yields no entries — so main
    // holds only the paragraph
    const faux = new window.fauxslt.Transform();
    faux.registerMatch('li', function () { return []; });
    const ul = document.getElementById('items');
    const main = ul.parentNode;
    faux.transform(ul);
    results['user empty body'] =
      main.querySelectorAll('li').length === 0 &&
      main.querySelectorAll('ul').length === 0;
    return results;
  });

  // every child netted nothing (comment/PI dropped, no children,
  // or a user body returning []), so the element is gone — not
  // left in place by an empty array smuggled through as a spec
  for (const k of Object.keys(out)) expect(out[k]).toBe(true);
});

test('a user named-PI template beats the built-in processing-instruction()', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    // regression: named processing-instruction(Literal) carries
    // §5.5 priority 0, beating the built-in bare NodeTest (−0.5).
    // under the old −0.25 it tied and never fired
    const xml = new DOMParser().parseFromString(
      '<w><r><?tgt payload?>keep<?other x?></r></w>',
      'application/xml');
    const r = xml.querySelector('r');
    const w = r.parentNode;

    const faux = new window.fauxslt.Transform();
    const seen = [];
    faux.registerMatch("processing-instruction('tgt')",
      function (ctx) {
        seen.push(ctx.node.target);
        return { '#span': 'pi:' + ctx.node.target };
      });
    faux.transform(r);

    return { seen, span: !!w.querySelector('span'),
      otherDropped: !Array.from(w.childNodes)
        .some(n => n.nodeType === 7),
      textKept: w.textContent.includes('keep') };
  });

  expect(out.seen).toEqual(['tgt']);
  expect(out.span).toBe(true);
  // the unclaimed PI dropped via the built-in
  expect(out.otherDropped).toBe(true);
  expect(out.textKept).toBe(true);
});

// --- null-on-empty -----------------------------------------------------
test('applyTemplates returns strict null on an empty node-set', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    let captured = {};
    faux.registerMatch("p[@id='para']", function (ctx) {
      // nothing in the document matches this select: null, not []
      captured.empty = ctx.applyTemplates('.//section');
      captured.strictNull = captured.empty === null;
      // the || idiom fires inside a body
      const fallback = ctx.applyTemplates('.//section') ||
        { '#span': 'fallback fired' };
      // and over the default (children) when there are none to net
      const xml = new DOMParser().parseFromString(
        '<w><r/></w>', 'application/xml');
      const r = xml.querySelector('r');
      const ctx2 = new window.fauxslt.Context(faux, r);
      captured.childless = ctx2.applyTemplates();
      return fallback;
    });
    faux.transform(document.getElementById('para'));
    return { ...captured,
      replaced: document.querySelector('main span')?.textContent };
  });

  expect(out.strictNull).toBe(true);
  expect(out.childless).toBeNull();
  // the || fallback produced the span in the output
  expect(out.replaced).toBe('fallback fired');
});

// --- the `_` default-namespace convention -----------------------------
test('bare-name patterns match in HTML natively, unrewritten', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const faux = new window.fauxslt.Transform();
    faux.registerMatch('li', function (ctx) {
      return { '#li': 'x ' + ctx.node.textContent };
    });
    const li = document.querySelectorAll('#items li')[0];
    const ts = faux.getMatchingTemplates(li);
    // page.html has no default namespace: the pattern compiled
    // UNREWRITTEN and matches the namespace-less li natively (the
    // built-in * matches too, at lower priority)
    const bare = ts.find(t => t.pattern === 'li');
    return { matched: !!bare,
      compiled: bare && bare.computedPattern,
      expr: bare && bare.expressions[0] };
  });
  expect(out.matched).toBe(true);
  expect(out.compiled).toBe('li');
  expect(out.expr).toBe('li');
});

test('bare-name pattern matches a default-namespaced XHTML document via _:', async ({ page }) => {
  // the same bare-name pattern, registered on an XML-parsed XHTML
  // document: the root's xmlns means the pattern compiled as
  // `_:body`-style rewrites and matches
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
    let title = null;
    faux.registerMatch('body', function (ctx) {
      // unprefixed EXPRESSIONS match too: rewritten per evaluation
      title = ctx.select('normalize-space(/html/head/title)');
      return { '#main': 'claimed' };
    });
    const body = document.body;
    const ts = faux.getMatchingTemplates(body);
    const compiled = ts.length ? ts[0].computedPattern : null;
    faux.transform(body);
    return { matched: !!ts.length, compiled, title,
      contentType: document.contentType };
  });

  expect(out.contentType).toBe('application/xhtml+xml');
  expect(out.matched).toBe(true);
  expect(out.compiled).toBe('_:body');
  expect(out.title).toBe('xhtml test');
});

test('no-namespace XML: unprefixed pattern and select match natively', async ({ page }) => {
  await go(page);
  const out = await page.evaluate(() => {
    const xml = new DOMParser().parseFromString(
      '<w><r><p>alpha</p><p>beta</p></r></w>', 'application/xml');
    const faux = new window.fauxslt.Transform();
    let seen = [], count = null;
    faux.registerMatch('p', function (ctx) {
      seen.push(ctx.node.textContent);
      count = ctx.select('count(//p)');
      return { '#span': ctx.node.textContent };
    });
    const r = xml.querySelector('r');
    const ts = faux.getMatchingTemplates(xml.querySelector('p'));
    faux.transform(r);
    return { compiled: ts[0].computedPattern, seen, count,
      spans: xml.querySelectorAll('span').length };
  });

  // nothing rewritten: the pattern compiled as written and the
  // unprefixed select netted the namespace-less elements
  expect(out.compiled).toBe('p');
  expect(out.seen).toEqual(['alpha', 'beta']);
  expect(out.count).toBe(2);
  expect(out.spans).toBe(2);
});
