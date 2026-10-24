// FauXSLT Registry: template registry, namespace mappings, and the
// transform driver. See the README for the behavioural contract.

import MARKUP from 'markup-mixup';
import { Template } from './template.js';
import { NamespaceMap } from './namespaces.js';
import { matchesNode, selectNodes } from './pattern.js';
import { Context } from './context.js';

export class Registry {

  constructor (namespaces) {
    this.namespaces = new NamespaceMap(namespaces);

    // derive mappings from the document root if nothing was given
    if (!namespaces && typeof document !== 'undefined' &&
      document.documentElement)
      this.namespaces.derive(document.documentElement);

    // compiled match templates and named templates, in the shape
    // { key -> Template }
    this.templates = new Map();
    this.named = new Map();

    // per-transform match cache, invalidated at every transform():
    // Map<match-expression-string, Set<matched node>>
    this._matchCache = new Map();

    // compiled XPathExpression cache, keyed weakly by document (a
    // registry can serve multiple documents; the expressions
    // themselves are reusable across transforms, so they outlive the
    // per-transform match cache and are only held while the document
    // lives)
    this._expressions = new WeakMap();
  }

  // get (or create) a compiled XPathExpression for a pattern in a
  // document, via document.createExpression. this front-loads the
  // expression parse to once per (pattern, document) instead of once
  // per evaluate() call in the match walk, and surfaces expression
  // errors at first use — consistent with fail-at-registration.
  _compiledExpression (compiled, doc) {
    let byExpr = this._expressions.get(doc);
    if (!byExpr) {
      byExpr = new Map();
      this._expressions.set(doc, byExpr);
    }
    const key = compiled.evalExpr || compiled.expr;
    if (!byExpr.has(key))
      byExpr.set(key, doc.createExpression(key, this.nsResolver()));
    return byExpr.get(key);
  }

  // register a template against a match pattern. the pattern is
  // compiled (validated) immediately; invalid syntax throws here.
  registerMatch (match, fn) {
    const t = new Template({ match, fn });
    this.templates.set(t.key, t);
    return t;
  }

  // register a named template
  registerNamed (name, fn) {
    const t = new Template({ name, fn });
    this.named.set(name, t);
    return t;
  }

  // namespace resolver for the native evaluator
  nsResolver () {
    return this.namespaces.resolver();
  }

  // evaluate a match pattern as a node-set, through the per-transform
  // cache. absolute patterns (rooted with / or //) evaluate once
  // from the document root. relative patterns are context-dependent:
  // per section 5.2 they are evaluated with each node as context, so
  // we walk the tree once, testing every element, and collect the
  // nodes for which the pattern yields a node-set containing them.
  _matchSet (template, root) {
    const expr = template.match.expr;
    if (this._matchCache.has(expr))
      return this._matchCache.get(expr);

    const set = new Set();

    if (template.match.absolute) {
      for (const n of this._evaluatePattern(template.match, root))
        set.add(n);
    }
    else {
      // relative patterns are context-dependent: walk the document
      // once and evaluate the pattern with every node (plus the
      // document itself) as context, collecting every node selected.
      // a node matches the pattern iff it appears in this union,
      // which anchors the pattern anywhere in the tree, exactly as
      // xslt match patterns behave.
      const doc = root.nodeType === 9 ? root : root.ownerDocument;
      for (const n of this._evaluatePattern(template.match, doc))
        set.add(n);
      for (const context of this._walk(doc))
        for (const n of this._evaluatePattern(template.match, context))
          set.add(n);
    }

    this._matchCache.set(expr, set);
    return set;
  }

  // evaluate a pattern as a node-set snapshot from a context node,
  // using the registry's precompiled XPathExpression
  _evaluatePattern (compiled, node) {
    const doc = node.ownerDocument || node;
    const expr = this._compiledExpression(compiled, doc);
    const r = expr.evaluate(node,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out = [];
    for (let i = 0; i < r.snapshotLength; i++)
      out.push(r.snapshotItem(i));
    return out;
  }

  // iterate every node in the document, in document order
  _walk (doc) {
    const out = [];
    if (doc.createNodeIterator && doc.documentElement) {
      const iter = doc.createNodeIterator(
        doc.documentElement, NodeFilter.SHOW_ALL);
      let n;
      while ((n = iter.nextNode())) out.push(n);
    }
    return out;
  }

  // find the best-matching template for a node: the one whose match
  // set is smallest (most specific); ties to most recently registered
  bestMatch (node, root) {
    let best = null;
    for (const t of this.templates.values()) {
      const set = this._matchSet(t, root);
      if (!set.has(node)) continue;
      if (!best || set.size < best.size ||
        (set.size === best.size && t.order > best.t.order))
        best = { t, size: set.size };
    }
    return best ? best.t : null;
  }

  // transform a node in place: find its best-matching template, call
  // it with a fresh Context bound, and replace the node with the
  // result. invalidates the match cache for this invocation.
  transform (node, params) {
    // the cache is only valid for one document state; transforms
    // mutate the DOM, so start fresh every time
    this._matchCache = new Map();

    const root = node.ownerDocument || node;
    const t = this.bestMatch(node, root);
    if (!t) return null;

    const ctx = new Context(this, node);
    const result = t.fn.call(ctx, params || {}, node);

    // result can be a markup-mixup spec (object/array/string), a DOM
    // node, or a DocumentFragment; bake specs with MARKUP and replace
    return this._replace(node, result, ctx);
  }

  // bake a markup-mixup spec into a detached fragment. MARKUP's
  // object convention always attaches to something, so we attach to
  // a throwaway fragment; MARKUP returns the last node in document
  // order, but the fragment always holds everything the spec
  // produced, so the fragment — not the return value — is the result.
  _bake (spec, ctx) {
    const frag = ctx.doc.createDocumentFragment();
    MARKUP({ parent: frag, spec, args: [ctx] });
    return frag.childNodes.length ? frag : null;
  }

  // replace node with the template result
  _replace (node, result, ctx) {
    if (result === null || typeof result === 'undefined') return null;

    let replacement = result;

    // markup-mixup specs are plain objects/arrays/strings: bake them
    if (!(result instanceof Node)) {
      replacement = this._bake(result, ctx);
      if (!replacement) return null;
    }

    if (!replacement || !replacement.nodeType) return null;

    if (replacement.nodeType === 11) {
      // document fragment: splice children in place of node
      const parent = node.parentNode;
      const next = node.nextSibling;
      if (!parent) {
        // orphan node (e.g. transform of a detached element): return
        return replacement;
      }
      parent.replaceChild(replacement, node);
      return replacement;
    }

    // single node
    if (!node.parentNode) return replacement;
    node.parentNode.replaceChild(replacement, node);
    return replacement;
  }
}