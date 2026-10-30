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
  `Context` instance as its argument.

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

export class Template {

  // #patterns: the compiled elementary branches of the match
  // pattern, per pattern.js: { expr, evalExpr, priority, absolute,
  // ast }. #rewrites: rewritten branch expression -> original
  // branch, exposing the transformation without recomputing.
  #patterns = null;
  #rewrites = null;
  #priority = null;
  #matchExpr = null;

  constructor ({ match = null, name = null, fn, priority = null,
    mode = null, prefix = null }) {
    if (typeof fn !== 'function')
      throw new TypeError('template requires a function');

    if (!match && !name)
      throw new Error(
        'template requires a match pattern, a name, or both');

    this.name = name;
    this.fn = fn;

    // the mode the template is registered under: null is the
    // default mode, per the transform spec's pattern-mode pair
    this.mode = typeof mode === 'string' ? mode : null;

    // an explicit priority overrides the §5.5 computed default
    this.#priority = typeof priority === 'number' ? priority : null;

    if (match) {
      this.#matchExpr = match;
      const compiled = compilePattern(match, { prefix });
      this.#patterns = compiled.branches;
      this.#rewrites = new Map(this.#patterns.map(b =>
        [b.evalExpr, b.expr]));
    }
  }

  // the original match pattern string, or null for named-only
  get pattern () {
    return this.#matchExpr;
  }

  // the original elementary branch expressions
  get patterns () {
    return this.#patterns ? this.#patterns.map(b => b.expr) : null;
  }

  // the rewritten expressions actually evaluated
  get expressions () {
    return this.#patterns ? this.#patterns.map(b => b.evalExpr) : null;
  }

  // the match pattern stitched back together from the rewritten
  // elementary branches (null for named-only templates)
  get computedPattern () {
    if (!this.#patterns) return null;
    return this.#patterns.map(b => b.expr).join(' | ');
  }

  // explicit override if present, else the computed §5.5 default.
  // the optional argument accepts an original branch expression, a
  // rewritten one, or nothing: for a union the branches may carry
  // different priorities, so the best (highest) is returned.
  getPriority (pattern) {
    if (this.#priority !== null) return this.#priority;
    if (!this.#patterns) return null;
    if (typeof pattern === 'string') {
      const b = this.#patterns.find(
        p => p.expr === pattern || p.evalExpr === pattern);
      if (b) return b.priority;
    }
    return Math.max(...this.#patterns.map(p => p.priority));
  }

  // compiled branch metadata for the Transform matching engine
  get branches () {
    return this.#patterns;
  }

  get kind () {
    return this.#matchExpr && this.name ? 'match+named' :
      this.#matchExpr ? 'match' : 'named';
  }

  // registry identity: the match pattern keys the pattern map;
  // named templates key the name map. a template with both keys
  // into both.
  get key () {
    return this.name || this.#matchExpr;
  }
}
