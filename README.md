# FauXSLT

> **FauXSLT is a JavaScript workalike of XSLT's .**

The browser vendors and the WHATWG have [committed to removing XSLT
1.0 from the Web
platform](https://github.com/whatwg/html/issues/11523), and with it,
the ability to transform XML documents, including RSS/Atom, OPML, and
XHTML, into other structures, including HTML, in the browser without
resorting to one of the myriad non-standard JavaScript templating
frameworks. This library, while of course _must_ rely on JavaScript,
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
target node, which will be replaced by the operation. Templates can be
also registered by name instead of, or in addition to by pattern, but
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
fauXSLT.registerMatch('body', () => {
  // `this` is bound to an execution context, which
  // has, among other things, the current node
  const classes = Array.from(this.node.classList);

  // mess with css classes
  if (isDraft && !('draft' in classes)) classes.push('draft');

  const header = this.copyOf('header') ||
    { '#header':
      { '#h1': this.select('normalize-string(/html/head/title)') } };

  let main = this.applyTemplates('.//main[not(@hidden)][1]') ||
    { '#main': this.callTemplate('article-shim') };

  // return value can be a markup-mixup spec or DOM node
  // or DocumentFragment or whatever
  return { '#body': [header, main, footer], class: classes };
});

fauXSLT.registerMatch('main[not(@hidden)]', () => {
  // this returns an object we can use as a node spec
  const main = this.getAttributes();

  // comme ça
  main['#main'] = this.callTemplate('article-shim');
  return main;
});

// this is like <xsl:template name="…">
fauXSLT.registerNamed('article-shim', () => {
  const articles = this.select('count(.//article)');

  return articles === 1 ? this.applyTemplates('.//article[1]') :
    articles === 0 ? { '#article': this.applyTemplates() } :
    this.applyTemplates();
});

// now this will replace the body
fauXSLT.transform(document.body);
```

## Template Body Functions

FauXSLT only needs to marshal the templates, since the template bodies
are just ordinary JavaScript. These take the form `(params) => {
/* ... */ }`. Template bodies are also bound to a `Context` object
which sets the `this` keyword. The context provides methods for things
like selecting and testing nodes, dereferencing documents, and
applying subsequent templates.

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
