// FauXSLT Context: the execution context bound as `this` inside
// template functions. Exposes the current node and the selection /
// recursion operations, per the README contract.

import MARKUP from 'markup-mixup';

export class Context {

  constructor (registry, node) {
    this.registry = registry;
    this.node = node;
    this.doc = node.ownerDocument || node;
  }

  // evaluate an arbitrary expression: returns a node array, number,
  // string, or boolean depending on the expression
  select (expression) {
    const resolver = this.registry.nsResolver();
    const r = this.doc.evaluate(expression, this.node, resolver,
      XPathResult.ANY_TYPE, null);
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