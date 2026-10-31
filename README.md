# FauXSLT

> **FauXSLT is a JavaScript workalike of XSLT 1.0.**

The browser vendors and the WHATWG have [committed to removing XSLT
1.0 from the Web
platform](https://github.com/whatwg/html/issues/11523), and with it
the ability of the browser to transform XML documents — RSS/Atom
feeds, OPML lists, XHTML pages — into other structures without
resorting to one of the myriad non-standard JavaScript templating
frameworks. This library, which of course _must_ rely on JavaScript,
is intended to provide similar functionality.

That is, FauXSLT is _not_ an XSLT engine; it just takes a similar
approach to transforming DOM trees.

> There is a separate effort called
> [SWeT](https://github.com/doriantaylor/swet) which intends to revive
> modern XSLT ([3.0](https://www.w3.org/TR/xslt-30/) and eventually
> [4.0](https://qt4cg.org/specifications/xslt-40/Overview.html) and
> beyond) with well-defined node selection semantics for HTML (XSLT ≥
> 3.0 already handles JSON) and a new compact syntax.

## How it works

Create a new `Transform` object and start registering templates with
match patterns, [just as you
would](https://www.w3.org/TR/xslt-10/#patterns) with XSLT. The
template bodies themselves are just ordinary JavaScript functions.

Once your templates are registered, you can `transform` your desired
target node, which will be replaced by the operation. Templates can
be registered by name instead of, or in addition to by pattern, but
only the pattern-matching templates are invoked from `transform`.

## Example

Here is an example of a simple template that shims in some basic
structural and presentation markup if it isn't already present:

```js
// my-transform.js

import { Transform } from 'fauxslt';

// sets up namespace mapping based on `document.documentElement`,
// plus some sane defaults; Does The Right Thing™ with (non-X)HTML.
const fauXSLT = window.fauXSLT = new Transform();

// suppose we have some out-of-band value
const isDraft = true;

// this is like <xsl:template match="…">
fauXSLT.registerMatch('body', (ctx) => {
  // the context is the one-stop shop for data and methods
  const classes = Array.from(ctx.node.classList);

  // mess with css classes
  if (isDraft && !classes.includes('draft')) classes.push('draft');

  const header = ctx.copyOf('header') ||
    { '#header':
      { '#h1': ctx.select('normalize-space(/html/head/title)') } };

  let main = ctx.applyTemplates('.//main[not(@hidden)][1]') ||
    { '#main': ctx.callTemplate('article-shim') };

  // return value can be a markup-mixup spec or DOM node
  // or DocumentFragment or whatever
  return { '#body': [header, main], class: classes };
});

fauXSLT.registerMatch('main[not(@hidden)]', (ctx) => {
  // ctx.getAttributes() returns { name: value }, which can be
  // spread straight into a spec
  const main = ctx.getAttributes();

  // comme ça
  main['#main'] = ctx.callTemplate('article-shim');
  return main;
});

// this is like <xsl:template name="…">
fauXSLT.registerNamed('article-shim', (ctx) => {
  const articles = ctx.select('count(.//article)');

  return articles === 1 ? ctx.applyTemplates('.//article[1]') :
    articles === 0 ? { '#article': ctx.applyTemplates() } :
    ctx.applyTemplates();
});

// now this will replace the body
fauXSLT.transform(document.body);
```

## Template Body Functions

FauXSLT only needs to marshal the templates, since the template bodies
are just ordinary JavaScript. These take the form `(ctx) => { /*
... */ }`. Template bodies are handed a `Context` object as their only
argument. The context provides access to the current node, the
parameter set, and methods for things like selecting and testing
nodes, dereferencing documents, and applying subsequent templates.

Because the `Context` is an explicit argument — not a `this`-binding —
arrow functions work as template bodies.

### Return Values

Template body functions are expected to behave as pure functions: they
take parameters and return a value, and don't rely on side effects.
The return value is expected to be a _spec_ suitable for uptake by the
declarative markup generator
[`markup-mixup`](https://github.com/doriantaylor/js-markup-mixup),
which includes most subclasses of (DOM)
[Node](https://developer.mozilla.org/en-US/docs/Web/API/Node). Otherwise
these specs are just ordinary primitive JS types, where elements are
represented as objects with the tag name prefixed by the `#` symbol,
and the other keys as the attributes. For instance, this:

```js
{ '#div':
  { '#h1':
    ['why ', { '#em': 'hello' }, ', there.'] },
  id: 'content' }
```

will produce `<div id="content"><h1>why <em>hello</em>, there.</h1></div>`.

> Note that if you return any nodes from the source document, they
> will be deep-copied instead of transformed, which may or may not be
> what you want.

### Parameters

`transform(node, params?)`, `ctx.applyTemplates(xpath?, params?,
mode?)`, and `ctx.callTemplate(name, params?)` all take a parameter
object. Parameters propagate pass-through, in the spirit of tunnel
parameters from later XSLTs: each template invocation receives its
own shallow copy of the merged object — incoming params over the
calling context's params — so a template mutating its `ctx.params`
cannot leak into siblings or ancestors. Parameter *values* should be
treated as immutable: the copy is shallow, so nested objects are
shared by reference.

Variables from the parameter set are **not** visible to XPath
expressions: `$foo` in a `select()`/`test()` expression is a syntax
error. Parameters live on the JavaScript side only.

### Matching, Priority, and Modes

When multiple templates match a node, the one with the highest
priority wins: [XSLT 1.0 §5.5](https://www.w3.org/TR/xslt-10/#conflict)
default priorities are computed per elementary pattern branch (a name
test is `0`, a wildcard or node-type test `-0.5`, a
namespace/any-namespace wildcard or `processing-instruction()` `-0.25`,
and any predicate bumps the branch to `0.5`). An explicit `priority`
can be given at registration. Equal priorities resolve to the
first-registered template.

Templates can be registered in a **mode**: a template registered for
mode `m` only applies when the transform is running in that mode, with
no fallback to default-mode templates (per §5.4). The mode is chosen
at `transform(node, params, mode)` and inherited through
`applyTemplates` unless overridden.

### Default Namespace

XPath 1.0 has no default namespace, and the browser's XPath engine is
never consulted for the empty prefix: an unprefixed name test matches
only namespace-less elements. So when a document's root carries a
default namespace (an unprefixed `xmlns="…"` — an XHTML page, an Atom
feed, an SVG document), FauXSLT binds that namespace to the synthetic
`_` prefix and rewrites every unprefixed element name test — in match
patterns AND in `select()`/`test()` expressions — to `_:name`. The
same pattern (`body`, `entry`, `circle`) then means the document's
own unprefixed elements.

Documents without a default namespace (HTML parsed as text/html,
no-namespace XML) are not rewritten at all: unprefixed names match
namespace-less elements natively. Note that a text/html document
whose root carries an explicit *non-XHTML* `xmlns` is broken input
under this design: the raw attribute classifies it
default-namespaced and rewrites to `_:name`, but the HTML parser
still reports the XHTML namespaceURI on its elements, so the names
match nothing. A polyglot document (text/html, `xmlns` = the XHTML
URI) works either way.

Escape hatches for mixed-namespace documents: an explicit prefix
(`svg:circle`) matches whatever the prefix is bound to (bound through
the `Transform` constructor's namespace map or an in-scope `xmlns:*`
declaration), and `*:name` matches any namespace. A document that
declares its own `xmlns:_` prefix wins: the synthetic rewrite is
disabled there, and `_:foo` means what the document declared.

One registration-time limitation: a template's pattern namespace is
fixed when it is registered, against the ambient document (or an
explicit namespace map). A template transforming nodes from a
*different* document — one fetched via `ctx.document()`, with a
different default namespace — needs prefixed patterns; expressions
inside the template are rewritten per evaluation document and resolve
correctly.

The `html:` prefix remains a default binding (XHTML) for prefixed
usage, but it is no longer special.

### Built-in Template Rules

Every `Transform` installs the [XSLT 1.0 §5.8](https://www.w3.org/TR/xslt-10/#built-in-rule)
built-in template rules at construction, as ordinary registered
templates in the default mode:

| pattern | priority | behaviour |
| --- | --- | --- |
| `*` | −0.5 | recurse into children (attributes **not** copied) |
| `/` | +0.5 | recurse into children (root nodes) |
| `text()` | −0.5 | copy the string value |
| `comment()` | −0.5 | drop the node |
| `processing-instruction()` | −0.5 | drop the node |

Priorities follow §5.5, with one known divergence: multi-step and
otherwise-qualified patterns compute from the LAST step only
(`a/b` → 0, `p/*` → −0.5), where §5.5's final clause would give
them +0.5. A user pattern that ties the built-in through this
divergence (e.g. `ul/*` against the built-in `*`) loses to the
first-registered rule — re-register the built-in's pattern
(`*`, `/`, etc.) to override.

Nothing about the built-ins is special: they are ordinary templates,
and **re-registering the same pattern+mode overwrites the built-in**
— that is the supported override path (a user `*` replaces the
element rule; a user `text()` replaces the text rule). A bare-name
user template (`li`, priority 0) always beats the built-in `*`
(−0.5), and a differently-spelled wildcard-equivalent pattern
(`node()`, `child::*`, priority −0.5) loses the tie to the built-in,
because equal priorities resolve to the first-registered template —
re-register `*` if you want to intercept everything. (Real XSLT
gives built-ins the lowest import precedence, so user rules win
ties there; FauXSLT's first-registered rule resolves in the
opposite direction, which is why re-registration is the override.)

Two deliberate divergences from §5.8:

- **Non-default modes carry no built-ins.** The built-ins are
  installed once, in the default mode only. A node transformed in a
  mode with no matching template hits the fallback below (recursion
  for elements, drop for text) rather than a mode-local built-in.
  A user wanting built-ins in a mode registers their own
  `*`/`text()`/etc. there — the ordinary registration path.
- **Document nodes are reachable only by absolute patterns.** The
  matching engine nets nodes from each visited element/document as
  context, so a document node is only ever netted by an absolute
  pattern. The built-in `/` (+0.5) outranks lower-priority absolute
  node tests such as `//node()` (−0.5) there — registering `/`
  is the override.

Note that `transform(documentNode)` is unsupported:
`markup-mixup`'s replace requires the target to have a parent node.
The `/` rule is reachable via `applyTemplates` over document-valued
`select()` results.

### Node Test Patterns

Because the matching engine evaluates each pattern with each
element or document as *context* and records every node it nets,
node test patterns (`text()`, `comment()`,
`processing-instruction()`) and attribute patterns (`@attr`) match
genuinely: the netted node is the one the template runs against.
Predicated node tests (`text()[normalize-space(.)='x']`) evaluate
natively in the same scan. DocumentType nodes are never netted by
any XPath node test and always fall to the fallback.

### No-Match Fallback

A node with no matching template in the active mode recurses into
its children, per the built-in element rule's shape — claimed
descendants still fire; text, comments, and processing instructions
with no claiming template drop. A template body that returns
nothing removes its node outright.

## API

### `Transform`

- **`new Transform(namespaces?, opts?)`** — create a new transform;
  namespace prefix mappings derive from `document.documentElement`
  unless given. `opts.identity` (default `false`) installs the
  [§7.5](https://www.w3.org/TR/xslt-10/#identity-copying) identity
  behaviour in place of the default built-ins: the `*`/`/` bodies
  shallow-copy the node — qualified name, attributes, in-scope
  namespace declarations, and processed children — and comments
  and processing instructions are preserved. Copy fidelity is
  best-effort: adjacent-text merging, attribute prefix edge cases,
  and doctype nodes are documented limitations.
- **`registerMatch (pattern, bodyFn, opts?)`** — register a body
  function against an XSLT 1.0 §5.2 match pattern (validated at
  registration; invalid syntax throws). `opts` is either an options
  object `{ mode?, priority?, name? }` or positional
  `(mode?, priority?)`. Registering with a `name` keys the name map
  as well. Re-registering the same pattern+mode overwrites.
- **`registerNamed (name, bodyFn)`** — register a body function under
  a name for `ctx.callTemplate`. Named templates are modeless.
- **`transform (node, params?, mode?)`** — transform `node` in place:
  find its best-matching template in the mode, hand the body a fresh
  `Context` (params minted per invocation), and replace the node
  with the resulting markup. A result that nets nothing removes the
  node.
- **`getMatchingTemplates (node, mode?)`** / **`getMatchingTemplate
  (node, mode?)`** — the matching templates for a node (sorted by
  descending priority) and the best one.

### `Context`

- **`node`** — the current node.
- **`params`** — the (copied, merged) parameter object for this
  invocation.
- **`mode`** — the active mode, or `null` for the default.
- **`select (expression)`** — evaluate arbitrary XPath; returns a
  node array, number, string, or boolean depending on the expression.
- **`test (expression)`** — truthiness of `select(expression)`.
- **`applyTemplates (xpath?, params?, mode?)`** — apply templates to
  the nodes netted by the expression (default: the current node's
  children). Returns an array of specs/nodes — itself a valid spec —
  or **`null`** when nothing was netted, so
  `ctx.applyTemplates(xpath) || fallback` is the supported fallback
  idiom (`markup-mixup` absorbs `null` in every spec position).
- **`callTemplate (name, params?)`** — invoke a named template with
  the current node as context.
- **`copyOf (expression)`** — clone the nodes netted by the
  expression, for splicing into output.
- **`getAttributes ()`** — `{ name: value }` map of the current
  node's attributes, for spreading into a spec.
- **`document (uri)`** — fetch, parse, and cache an external XML
  document (the analogue of XSLT's `document()`; synchronous).

## Invocation

Making your transform script a module will conveniently cause it to be
run after the document tree is constructed, just before the
`DOMContentLoaded` event — which is exactly when you'd want it to:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>transform this</title>
    <script type="module" src="my-transform.js"></script>
  </head>
  <body>
    <p>change meeee</p>
  </body>
</html>
```

It also makes managing the dependencies a lot easier. Note as well
that if you persist the transform (e.g. by attaching it to `window`),
you can invoke it anytime in the document's lifecycle.

## Installation

Typical `npm`/`pnpm`/whatever package manager you're used to.

```sh
pnpm install fauxslt
```

## Copyright & License

Copyright 2026 [Dorian Taylor](https://doriantaylor.com/)

This software is provided under
the [Apache License, 2.0](https://www.apache.org/licenses/LICENSE-2.0).