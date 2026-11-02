// FauXSLT Context: the execution context handed to template functions.

/*
  What follows in this comment block are human-originated
  implementation notes.

  The purpose of the execution `Context` is really just to have
  something to hand to template body functions. Through this
  mechanism, the execution context makes certain methods and data
  available to the template body functions.

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

  The constructor furthermore takes the parameter object, which is
  minted anew with each Context (see below) so that mutation of one
  template's parameters cannot leak into another's — no spooky action
  at a distance.

  Here is how this class would be invoked from `Transform`:

  ```
  // as part of class Transform

  transform (node, params) {
      const ctx  = new Context(this, node, params);
      const spec = ctx.applyTemplates('self::node()');

      // note that MARKUP returns the last node added
      return MARKUP({ replace: node, spec: spec, args: [ctx] });
  }
  ```

  The implementations of `applyTemplates` and `callTemplate` only need
  to forward on the return value from the chosen template's body
  function. DOM manipulation _only_ happens via the `transform` method
  in the `Transform` class.

  Note that the parameters should propagate, similar to pass-through
  parameters in later XSLTs, but the parameter object should be
  copied via `Object.assign` before being handed to the template body
  function — hence `applyTemplates` and `callTemplate` mint a fresh
  Context (and thus a fresh merged parameter object) per invocation:
  the incoming `params` are merged over the current Context's own.

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


import { rewriteExpression } from './expressions.js';

export class Context {

  constructor (registry, node, params, mode = null) {
    this.registry = registry;
    this.node = node;
    this.doc = node.ownerDocument || node;

    // the active mode, inherited through applyTemplates unless
    // overridden; null is the default mode
    this.mode = mode;

    // parameters are yoked to the Context at mint: each invocation
    // gets its own (shallow) copy, so downstream templates can mutate
    // their params without leaking into siblings or ancestors. the
    // merge chain is most-specific-wins: registry globals <
    // transform() params < applyTemplates/callTemplate params.
    this.params = Object.assign({}, params || {});
  }

  // evaluate an arbitrary expression: returns a node array, number,
  // string, or boolean depending on the expression. the expression
  // is precompiled per (registry, document) through the registry's
  // XPathExpression cache — select() is typically called in loops,
  // and createExpression front-loads the parse. when the registry
  // and the context document share a default-namespace state, the
  // expression is first REWRITTEN: unprefixed element name tests
  // become `_:name`, resolved against the document's
  // default-namespace URI by the registry's per-document resolver
  // (see Transform.effectiveDefaultPrefix). documents without a
  // default namespace pass through untouched, so unprefixed names
  // match namespace-less elements natively. this is the same
  // rewrite match patterns get at registration time, funneled
  // through the same decision source.
  select (expression) {
    const prefix = this.registry.effectiveDefaultPrefix(this.doc);
    const string = prefix ?
      rewriteExpression(expression, prefix) : expression;
    const expr = this.registry.compiledExpression(
      string, this.doc);
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

  // find the best template for a node through the registry's
  // node-match index, in the active mode
  _bestTemplate (node) {
    return this.registry.getMatchingTemplate(node, this.mode);
  }

  // apply templates to a node-set. the first argument is polyvalent:
  // omitted, null, undefined, or '' nets the current node's children
  // (unchanged); an XPath string is evaluated through select()
  // (rewritten per the evaluation document's default namespace);
  // a precompiled XPathExpression instance is evaluated VERBATIM
  // against the current node — a compiled object cannot be
  // rewritten, so the caller's own bindings are the contract (this
  // asymmetry with the string form is deliberate: prefer the string
  // when the default-namespace rewrite is wanted, the instance when
  // it is not); anything with a numeric nodeType (a Node, Document,
  // DocumentFragment, attribute) routes as a singleton; an Array,
  // NodeList, or HTMLCollection routes as a node list; anything else
  // throws a TypeError. this gives the XSLT document($uri) idiom a
  // spelling — ctx.applyTemplates(ctx.document(uri)) — and lets a
  // template body route the nodes it already holds without paying
  // for an XPath round trip. the mode is inherited from this
  // Context unless overridden by the third argument. returns an
  // array of results — markup-mixup specs and/or DOM nodes — or
  // NULL when nothing was netted, so `applyTemplates(...) ||
  // fallback` idioms work (null is falsy; an empty array would
  // not be). this matches `copyOf` (null on empty) and
  // `callTemplate` (null on missing). null is itself absorbed by
  // markup-mixup in every spec position (a null entry is a
  // no-op), and by transform()'s drop path, so DOM assembly
  // stays in `Transform.transform`.
  applyTemplates (expression, params, mode) {
    let nodes = null;
    if (typeof expression === 'undefined' ||
      expression === null || expression === '')
      nodes = Array.from(this.node.childNodes);
    else if (typeof expression === 'string') {
      const out = this.select(expression);
      nodes = Array.isArray(out) ? out : [out];
    }
    else if (typeof XPathExpression !== 'undefined' &&
      expression instanceof XPathExpression) {
      // verbatim: the caller compiled it, the caller resolves it
      const r = expression.evaluate(this.node,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      nodes = [];
      for (let i = 0; i < r.snapshotLength; i++)
        nodes.push(r.snapshotItem(i));
    }
    else if (typeof expression.nodeType === 'number')
      nodes = [expression];
    else if (Array.isArray(expression) ||
      (typeof NodeList !== 'undefined' &&
        expression instanceof NodeList) ||
      (typeof HTMLCollection !== 'undefined' &&
        expression instanceof HTMLCollection))
      nodes = Array.from(expression);
    else
      throw new TypeError('applyTemplates(): cannot interpret ' +
        'argument: ' + String(expression));

    // every routed member must be a node — including the string
    // path's wrapped results: a non-node-set expression result
    // throws HERE with a clear message instead of deep inside
    // matching (the same fail-loudly outcome, better spelled)
    for (const n of nodes)
      if (!n || typeof n.nodeType !== 'number')
        throw new TypeError('applyTemplates(): not a node: ' +
          String(n));

    const m = typeof mode === 'undefined' ? this.mode : mode;
    const results = [];
    for (const n of nodes) {
      // uniform registry routing: every child node (any kind) is
      // looked up like any other. nodes the registry can't net —
      // non-elements, or elements with no template in the mode —
      // hit the fallback: elements/documents recurse into their
      // children (like the built-in rule would), non-elements
      // produce nothing.
      const t = this.registry.getMatchingTemplate(n, m);
      if (t) {
        // fresh Context per node: params merge incoming over current,
        // mode inherited
        const ctx = new Context(this.registry, n,
          Object.assign({}, this.params, params), m);
        const result = t.fn(ctx);
        if (result === null || typeof result === 'undefined') continue;
        // an array result is a list of specs: spread it, so an
        // EMPTY array nets nothing (pushed whole it would read as
        // one non-empty element downstream and defeat the drop
        // semantics — e.g. the built-in * body over an element
        // whose every child drops)
        if (Array.isArray(result))
          for (const r of result) results.push(r);
        else results.push(result);
      }
      else if (n.nodeType === 1 || n.nodeType === 9) {
        // fallback: recurse into children, per the built-in
        // element rule's shape. the recursion results are spread
        // so an empty recursion yields NOTHING here — an empty
        // array pushed as a single element would read as a
        // non-empty spec downstream and defeat the drop semantics.
        // null-on-empty (the current contract) must not reach the
        // spread at all, hence the guard
        const ctx = new Context(this.registry, n,
          Object.assign({}, this.params, params), m);
        const kids = ctx.applyTemplates();
        if (kids) results.push(...kids);
      }
      // non-elements with no template: dropped
    }
    // null — not [] — when nothing was netted: falsy, so the
    // `applyTemplates(...) || fallback` idiom works
    return results.length ? results : null;
  }

  // invoke a named template with the current node as context
  callTemplate (name, params) {
    const t = this.registry.named.get(name);
    if (!t) return null;

    // a named template gets its own Context: the incoming params
    // merge over this Context's own (pass-through, as above)
    const ctx = new Context(this.registry, this.node,
      Object.assign({}, this.params, params));
    return t.fn(ctx);
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

  // map of the current node's attributes: { name: value }. handy for
  // spreading existing attributes into a markup-mixup spec
  getAttributes () {
    const out = {};
    if (!this.node.attributes) return out;
    for (const a of this.node.attributes) out[a.name] = a.value;
    return out;
  }

  // fetch and parse an external XML document by URI, the analogue of
  // XSLT's document(). synchronous by design (the template pipeline
  // is synchronous; fetch offers no sync mode, so XMLHttpRequest in
  // async:false mode is the only browser mechanism). returns the
  // parsed Document on success, or NULL on failure — a transport
  // failure (a non-200/non-0 status) or a parse error (a
  // parsererror root) — never throwing. the null is CACHED like a
  // success: one GET per URI per registry, failures included, so a
  // transient failure poisons the URI for the Transform's lifetime
  // (matching the success path's caching shape; a retry that can
  // recover needs a fresh Transform). NOTE the interaction with
  // polyvalent applyTemplates: after a failed fetch,
  // ctx.applyTemplates(ctx.document(uri)) is applyTemplates(null) —
  // the CURRENT node's children, silently. guard the call site:
  // const doc = ctx.document(uri); if (doc) ctx.applyTemplates(doc).
  document (uri) {
    // resolve relative URIs against the current document
    const abs = new URL(uri,
      this.doc.baseURI || document.baseURI).href;
    if (!this.registry.documents) this.registry.documents = new Map();
    if (this.registry.documents.has(abs))
      return this.registry.documents.get(abs);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', abs, false);
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0)
      return this.#cacheFailure(abs);

    const parsed = new DOMParser().parseFromString(
      xhr.responseText, 'application/xml');
    // DOMParser reports parse errors as a document with a
    // parsererror root, not an exception
    if (parsed.getElementsByTagName('parsererror').length)
      return this.#cacheFailure(abs);

    this.registry.documents.set(abs, parsed);
    return parsed;
  }

  // record a failed fetch: the null rides the same per-URI cache
  // as a success, so the URI is fetched once per registry lifetime
  #cacheFailure (abs) {
    this.registry.documents.set(abs, null);
    return null;
  }
}