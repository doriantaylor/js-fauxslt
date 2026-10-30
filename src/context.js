// FauXSLT Context: the execution context bound as `this` inside
// template functions.

/*
  What follows in this comment block are human-originated
  implementation notes.

  The purpose of the execution `Context` is really just to have
  something to bind template body functions to so `this` can be made
  use of. Through this mechanism, the execution context makes certain
  methods and data available to the template body functions.

  Actually `MARKUP` need not be in this module; it only needs to be in
  the `Transform` module since it will only need to be invoked from
  `transform`. `MARKUP` furthermore has a `replace` keyword, which
  makes it possible to replace a target node with the spec. `MARKUP`
  also walks the spec and constructs the DOM tree all in one shot;
  there is no incremental composition.

  The constructor indeed needs a backreference to the `Transform`,
  although only for the purposes of `applyTemplates` and
  `callTemplate`, as well as the namespace resolver for the other
  XPath methods. It also requires the current node as the basis for
  arbitrary XPath expressions.

  Here is how this class would be invoked from `Transform`:

  ```
  // as part of class Transform

  transform (node, params) {
    const ctx  = new Context(this, node);
    const spec = ctx.applyTemplates('self::node()', params);

    // note that MARKUP returns the last node added
    return MARKUP({ replace: node, spec: spec });
  }
  ```

  The implementations of `applyTemplates` and `callTemplate` only need
  to forward on the return value from the chosen template's body
  function. DOM manipulation _only_ happens via the `transform` method
  in the `Transform` class.

  Note that the parameters should propagate, similar to pass-through
  parameters in later XSLTs, but the parameter object should be copied
  via `Object.assign` before being handed to the template body
  function.

  We need analogues of the following functionality for handling
  arbitrary XPath:

  * `<xsl:apply-templates>`
  * the `select=` attribute in e.g. `<xsl:variable select="…"/>`
  * the `test=` attribute in e.g. `<xsl:if test="…"/>`
  * `<xsl:copy-of>`

  We also need versions of these:

  * `<xsl:call-template>`
  * the `document()` function (this can just simplify the fetch API
    and run it synchronously)

  This list may not yet be complete.

  The ensuing implementation (and its concomitant tests) should
  reflect this specification.
 */


import MARKUP from 'markup-mixup';

export class Context {

  constructor (registry, node) {
    this.registry = registry;
    this.node = node;
    this.doc = node.ownerDocument || node;
  }

  // evaluate an arbitrary expression: returns a node array, number,
  // string, or boolean depending on the expression. the expression
  // is precompiled per (registry, document) through the registry's
  // XPathExpression cache — select() is typically called in loops,
  // and createExpression front-loads the parse.
  select (expression) {
    const expr = this.registry._compiledExpression(
      { evalExpr: expression }, this.doc);
    const r = expr.evaluate(this.node, XPathResult.ANY_TYPE, null);
    switch (r.resultType) {
      case XPathResult.NUMBER_TYPE:  return r.numberValue;
      case XPathResult.STRING_TYPE:  return r.stringValue;
      case XPathResult.BOOLEAN_TYPE: return r.booleanValue;
      default: {
        const nodes = [];
        let n;
        while ((n = r.iterateNext())) nodes.push(n);
        return nodes;
      }
    }
  }

  // truthiness of select()
  test (expression) {
    return !!this.select(expression);
  }

  // find the best template for a node through the registry
  _bestTemplate (node) {
    return this.registry.bestMatch(node, this.doc);
  }

  // apply templates to the nodes netted by the expression (default:
  // the current node's children). returns a DocumentFragment of the
  // concatenated results, or null if nothing was produced.
  applyTemplates (expression, params) {
    let nodes = [];
    if (typeof expression === 'undefined' ||
      expression === null || expression === '')
      nodes = Array.from(this.node.childNodes);
    else {
      const out = this.select(expression);
      nodes = Array.isArray(out) ? out : [out];
    }

    const frag = this.doc.createDocumentFragment();
    for (const n of nodes) {
      const t = this._bestTemplate(n);
      if (!t) {
        // no template: keep the node as-is (analogous to the
        // built-in template in XSLT, which copies through)
        frag.appendChild(n.cloneNode(true));
        continue;
      }
      const ctx = new Context(this.registry, n);
      const result = t.fn.call(ctx, params || {}, n);
      if (result === null || typeof result === 'undefined') continue;
      this._append(frag, result, ctx);
    }
    return frag.childNodes.length ? frag : null;
  }

  // invoke a named template with the current node as context
  callTemplate (name, params) {
    const t = this.registry.named.get(name);
    if (!t) return null;
    const ctx = new Context(this.registry, this.node);
    const result = t.fn.call(ctx, params || {}, this.node);
    return result;
  }

  // clone the nodes netted by the expression for splicing into
  // output: a fragment (multiple nodes) or a single node
  copyOf (expression) {
    const out = this.select(expression);
    const nodes = Array.isArray(out) ? out : [out];
    if (!nodes.length) return null;
    if (nodes.length === 1) return nodes[0].cloneNode(true);
    const frag = this.doc.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n.cloneNode(true));
    return frag;
  }

  // bake a result (spec or node) and append to a fragment. specs are
  // baked via the registry's fragment-bake so nothing attaches to the
  // live document during baking.
  _append (frag, result, ctx) {
    let out = result;
    if (!(result instanceof Node))
      out = ctx.registry._bake(result, ctx);
    if (out && out.nodeType) frag.appendChild(out);
  }
}
