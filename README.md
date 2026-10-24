# FauXSLT

**A stopgap for the imminent elimination of XSLT from web
browsers.**

The WHATWG has committed to removing XSLT 1.0 from the web platform
([whatwg/html#11523](https://github.com/whatwg/html/issues/11523)),
and with it the ability of a plain XML document — an RSS/Atom feed, an
OPML list, a sitemap, a "skinless" XHTML page — to render itself in a
browser without JavaScript. This library is the short-term response to
that removal: if the browser will no longer transform XML for you,
bring the transform to the document.

FauXSLT is *not* an XSLT engine. It is a template registry with
XSLT-*like* semantics — match templates, named templates, node
selection — implemented as ordinary JavaScript, with markup generated
by [markup-mixup](https://github.com/doriantaylor/js-markup-mixup)
from plain objects and arrays. The long-term argument for keeping
declarative web templating around lives in the
[SWeT proposal](https://github.com/doriantaylor/swet); this is the
bridge until something like it — or a resurrected XSLT — lands.

## How it works

You register template functions against XPath-ish match expressions,
then transform a node. FauXSLT finds the template whose match
expression selects the fewest nodes (most specific match wins), calls
it, and replaces the node with the result. Template functions receive
a `Context` bound as `this`, which exposes the current node, node
selection, and recursive application of templates.

```js
import { Registry } from 'fauxslt';

// sets up namespace mapping based on `document.documentElement`,
// plus some sane defaults; Does The Right Thing™ with (non-X)HTML.
const faux = new Registry();

// like <xsl:template match="…">
faux.registerMatch('body', function () {
  // `this` is the execution Context; this.node is the current node
  const classes = Array.from(this.node.classList);

  // return value can be a markup-mixup spec, a DOM node, a
  // DocumentFragment, or a string
  return { '#body': [
    { '#header': this.applyTemplates('/html/head/title') },
    this.applyTemplates('.//main[1]'),
    { '#footer': 'fin' },
  ], class: classes };
});

// like <xsl:template name="…">
faux.registerNamed('article-shim', function () {
  const n = this.select('count(.//article)');
  return n === 1 ? this.applyTemplates('.//article[1]') :
    n === 0 ? { '#article': this.applyTemplates() } :
    this.applyTemplates();
});

// replace document.body in place with the transformation
faux.transform(document.body);
```

## Design

The contract is a set of ordinary functions hanging off ordinary
objects, so everything is inspectable, debuggable, mockable, and
tree-shakable — no XML syntax to transpile, no WASM to load, no
special authoring format. Because templates are JavaScript functions,
the full language is available: variables, closures, imports,
conditional logic. The declarative core — *which template matches
which node* — is retained from XSLT; the syntax is not.

### Registry

The `Registry` holds templates and namespace bindings and drives
transformation.

- **`new Registry()`** — create an empty registry.
- **`registerMatch (expression, fn)`** — register `fn` to run against
  nodes netted by the match expression. When multiple templates match
  a node, the one whose expression selects the fewest nodes runs;
  ties resolve to the most recently registered.
- **`registerNamed (name, fn)`** — register `fn` under a name for use
  with `callTemplate`.
- **`transform (node, params)`** — transform `node` in place: find the
  best-matching template, call it, and replace `node` with the result.
  `params` is an optional object passed to the template (analogous to
  `<xsl:with-param>`).

### Context

The `Context` is the execution context for a template invocation,
bound as `this` inside template functions.

- **`node`** — the current node.
- **`select (expression)`** — return whatever the expression nets:
  a node-set (array-like), a number, or a string, depending on the
  expression. Returns `null`/`undefined`/zero-length when nothing
  matches.
- **`test (expression)`** — truthiness of `select(expression)`.
- **`applyTemplates (expression?, params?)`** — for every node netted
  by the expression (default: the current node's children), find the
  matching template and collect its result. Returns a
  `DocumentFragment` with the concatenated results, or `null` if
  nothing matched or was produced.
- **`callTemplate (name, params?)`** — invoke a named template with
  the current node as context.
- **`copyOf (expression)`** — clone the nodes netted by the
  expression, as a fragment or single node, for splicing into the
  output.

### What "XPath-ish" means

FauXSLT accepts the XPath subset needed for matching and selection:
absolute and relative paths, `.` and `..`, `@attribute` steps,
predicates like `[1]`, `[last()]`, `[not(@hidden)]`, position calls,
and `count()`. Namespace prefixes resolve against the registry's
bindings. Unsupported expressions throw rather than silently
misbehave. CSS selectors are deliberately *not* the format — they
don't do ancestor descent (`../..`) or raw-text nodes (`text()`),
which template matching needs.

### Integration patterns

#### Standalone documents (feeds, sitemaps)

Pair the document with a bootstrap `<script>` (the mitigation settled
on in the WHATWG thread: no new script-execution mechanism is added —
see [mfreed7's
polyfill](https://github.com/mfreed7/xslt_polyfill) for the XSLT-native
equivalent):

```xml
<?xml version="1.0"?>
<?xml-stylesheet href="feed.js" type="text/javascript"?>
<!-- the xml-stylesheet PI is optional; a <script> works too -->
```

where `feed.js` fetches the source document (when running from an
external file), constructs the `Registry`, and calls `transform()` on
the root. Because FauXSLT is pure JS, it runs from a `<script>` tag,
an ES module import, or a server-side bundling step, whichever the
document can afford.

#### In-page HTML surgery

For (X)HTML documents, `transform()` operates on live DOM: register
matches against real elements, and the page rewrites itself as soon
as the script runs.

### Relationship to markup-mixup

Templates return *specs* — plain objects and arrays — and
markup-mixup bakes them into DOM. Templates never touch the DOM
directly unless they want to; a returned node or fragment is inserted
as-is. This separation keeps the declarative shape of a template
legible at a glance, and lets specs be tested without a DOM by
comparing objects.

## Limitations (deliberate)

- **Not an XSLT engine.** No `xsl:for-each`-style ordering controls
  beyond what the match expression nets; no modes, no `xsl:sort`, no
  keys, no output-method serialization settings. These are
  expressible in the template functions themselves, which is the
  point.
- **No streaming.** The whole source must be in memory.
- **XPath 1.0 subset.** Enough to match and select; not a complete
  implementation. Unsupported syntax throws immediately.
- **Browser and Node.** Requires a DOM implementation (native
  browser DOM, or jsdom/linkedom server-side); no WASM.

## Installation

```sh
pnpm install fauxslt
```

## Copyright & License

Copyright 2026 [Dorian Taylor](https://doriantaylor.com/)

This software is provided under
the [Apache License, 2.0](https://www.apache.org/licenses/LICENSE-2.0).