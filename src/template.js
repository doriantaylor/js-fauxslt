// Template metadata for fauxslt. A template pairs an optional match
// pattern (XSLT <xsl:template match="…">) and/or a name
// (<xsl:template name="…">) with the function that runs when it is
// selected. Match expressions are compiled at construction time so
// invalid patterns throw at registration, not mid-transform.

import { compilePattern } from './pattern.js';

/*
  What follows in this comment block are human-originated
  implementation notes.

  For starters you don't need a global `order` in this module; if
  insertion order is truly important then we can make the data
  structures in `Transform` (or if we rename it, `Stylesheet` or
  `Transform`) reflect that.

  The main role of this class is to yoke together the metadata around
  a given template. A template keys on a match pattern (qua §5.2 of
  the XSLT spec), or symbolic name, or both. The `body` is a function
  that returns an object that can serve as a `markup-mixup` spec
  (which includes any instance of `Node`). The function will take a
  `params` object as an argument which will be synthesized by its
  execution context and can thus be freelyl manipulated (or ignored),
  and is expected to be bound (ie via `Function.bind`) to a `Context`
  object, which provides the `this` to the function.

  One issue with XSLT (1.0) templates, which the FauXSLT package is
  meant to emulate, is that a _match pattern_ is only a _subset_ of
  XPath, plus a `key()` function which is not part of the XPath 1.0
  spec. We have no plans to implement this function so its presence
  should raise an exception saying so.

  This entails an XPath parser, provided by `xpath-pattern.peggy`,
  which gives us a precompiled PEG parser. Given that we already have
  a parser to assert the proper subset of an XPath expression such
  that it can be handed to the browser's stock
  `XPathEvaluator.createExpression()` with some reasonable
  expectations about its behaviour, we can also leverage it to rewrite
  the patterns:

  * for starters, split out top-level (ie non-predicate) unions (ie `|`)
  * blow up on invocation of `key()` (we already said that)
  * rewrite relative path expressions of the form of eg `a/b//c` to
    `c[ancestor-or-self::b/parent::a]`, ie rewrite it as if it was the
    default (ie child) axis, prepending the inverse of the original
    path to the predicates
    * this will make it possible to precompile and evaluate elementary
      match patterns when doing the preemptive scan in the `Transform`.

  Therefore, a `Template` should possess a member of the form `{
  rewrittenExpr: [XPathExpression, computedPriority] }`.  We can call
  that a private member `#patterns`. Plus another one called
  `#rewrites` of the form `{ originalExpr: rewrittenExpr }`. We can
  also make a synthetic getter `patterns` which just divulges an array
  of keys, one called `expressions` which divulges an array of
  compiled expressions, and `computedPattern` that will stitch the
  union of elementary expressions back together but with rewritten
  paths. The original match pattern should be saved as the member
  `pattern`. It should also have a method `getPriority(pattern)` which
  can take either the original pattern, the rewritten one, or the
  compiled `XPathExpression`, and return either the computed priority
  or the overriding `priority` member if one is present.

  The ensuing implementation (and its concomitant tests) should
  reflect this specification.
 */

// registration counter: higher = more recent, which breaks ties in
// favour of the most recently registered template
let _order = 0;

export class Template {

  constructor ({ match = null, name = null, fn }) {
    if (typeof fn !== 'function')
      throw new TypeError('template requires a function');

    if (!match && !name)
      throw new Error(
        'template requires a match pattern, a name, or both');

    this.match = match ? compilePattern(match) : null;
    this.name = name;
    this.fn = fn;
    this.order = _order++;
  }

  get kind () {
    return this.match && this.name ? 'match+named' :
      this.match ? 'match' : 'named';
  }

  // identity used for registry storage and the match cache
  get key () {
    return this.name || this.match.expr;
  }
}
