// FauXSLT Transform: template registry, namespace mappings, and the
// transform driver. See the README for the behavioural contract.

/*
  What follows in this comment block are human-originated
  implementation notes.

  Note this module was renamed from `Registry` to `Transform` to be
  congruent with the alternate XSLT 1.0 root element
  `<xsl:transform>`, and because the concept of a "stylesheet" is
  already largely monopolized by CSS.

  The role of the `Transform` class is to act primarily as a resolver
  for templates and namespaces, as well as provide an entry point for
  subtree transformation.

  This class mimics an XSLT stylesheet through `registerMatch`
  (analogous to `<xsl:template match="…">`) and `registerNamed`
  (analogous to `<xsl:template name="…">`). These will be factory
  methods for the constructor for `Template`. There is furthermore the
  `transform` method that begins the transformation process, which
  should replace the node passed in as an argument. The constructor
  for `Transform` should provide a mechanism for registering namespace
  prefix mappings, otherwise it should derive them from a node or
  `document.documentElement`. That should constitute the public
  interface.

  An important element of the implementation is the template registry
  itself. We will need two maps, one keyed by a string representation
  of the XPath match pattern, and another bye template name. Note that
  a given `Template` can have both, so the registration functions need
  to take this into account. Ideally these functions should run the
  `Template` constructor first and then use the resulting object's
  instance data for this mapping. The map should take the form
  `(pattern, Map(mode, template))`, with `null` for the default
  mode. So really a pattern is a pattern-mode pair. Re-registering a
  template, whether named or pattern, should overwrite it.

  The `transform(node, params, mode)` method needs to resolve an
  initial template, and `Context.applyTemplates(xpath, params, mode)`
  needs to resolve arbitrary XPath (ie NOT the match patterns)
  relative to the context node (or a null XPath, equivalent to
  `node.childNodes`). It would be useful therefore for the registry to
  memoize a `WeakMap` of the form `(node, Set(templates))`, so one
  could easily derive from there (eg mode, priority) which template to
  apply.

  To deal with unbound nodes, document fragments, etc, we will also
  wrap that aforementioned `WeakMap` in another one keyed on the root
  (eg `document`), so the ultimate form of this structure (we can call
  it `#nodeMatches`) will be `WeakMap(root, WeakMap(node,
  Set(templates)))`.

  We will then need a private method (something like `#walk`) that
  invokes the algorithm to populate these maps, which can be lazy and
  run at the beginning of `transform`:

  * iterate over each of the registered match templates
  * extract their rewritten expressions (see `Template`)
  * create an intermediate structure of the form { xpathString:
    [compiledExpr, Set(matchingTemplates)] }
    * (use a plain object to deduplicate the expressions)
    * (since there will be multiple copies of the same compiled
      expression which will be semantically identical but have
      different identities, just use the first one encountered)
    * once compiled-expression → template relations have been
      collated, transform the object values into a `Map`
      * set aside the absolute and the `id()` paths
      * (these structures can stick around until a new template is registered)

  Now we can consider the actual algorithm to populate `#nodeMatches`:

  * begin at the root (document or fragment) and scan its children
    * (unbound elements will probably need to be provisionally bound
      to a `DocumentFragment` or something)
    * if the node is a document, test the absolute expressions
    * if the node is the root (not necessarily a document), test the
      `id()` expressions
    * test each child node against each compiled expression (boolean is fine)
    * if the expression matches:
      * add the (root, WeakMap) pair to #nodeMatches
      * add the (node, Set) pair to the `WeakMap` if it doesn't exist
      * add the template to the set
      * recurse if the child node is an element

  (That might be amenable to being async but we probably want to await
  it before we actually test anything against it.)

  Since the `Map` and `Set` interfaces are clunky, we should also
  surface some quasi-private methods like `getMatchingTemplates(node,
  mode?)` which returns an array of matching templates for the node
  (and optional mode) sorted by priority, and
  `getMatchingTemplate(node, mode?)` which just wraps that to get the
  'best' one.

  It probably also wouldn't hurt to just encapsulate `new
  XPathevaluator().createExpression` with the embedded namespace
  mapping to save a step; maybe not try to be clever and just call it
  `createExpression`. Might as well just make an `#evaluator` member
  since that's an instance method anyway.

  The ensuing implementation (and its concomitant tests) should
  reflect this specification.
*/

import MARKUP from 'markup-mixup';
import { Template } from './template.js';
import { NamespaceMap } from './namespaces.js';
import { Context } from './context.js';

export class Transform {

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
        // lives). a single XPathEvaluator instance serves all documents.
        this._expressions = new WeakMap();
        this._evaluator = typeof XPathEvaluator === 'function' ?
            new XPathEvaluator() : null;
    }

    // get (or create) a compiled XPathExpression for a pattern in a
    // document, via XPathEvaluator.createExpression. this front-loads
    // the expression parse to once per (pattern, document) instead of
    // once per evaluate() call in the match walk, and surfaces
    // expression errors at first use — consistent with
    // fail-at-registration.
    _compiledExpression (compiled, doc) {
        let byExpr = this._expressions.get(doc);
        if (!byExpr) {
            byExpr = new Map();
            this._expressions.set(doc, byExpr);
        }
        const key = compiled.evalExpr || compiled.expr;
        if (!byExpr.has(key))
            byExpr.set(key, this._evaluator.createExpression(
                key, this.nsResolver()));
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
    // evaluate a match pattern as a node-set union across the whole
    // tree, through the per-transform cache. absolute patterns
    // evaluate once from the document root. relative patterns are
    // context-dependent: per section 5.2 they are evaluated with each
    // node as context, so we walk the tree once, testing every
    // element, and collect the nodes for which the pattern yields a
    // node-set containing them. unions contribute per branch.
    _matchSet (template, root) {
        const expr = template.pattern;
        if (this._matchCache.has(expr))
            return this._matchCache.get(expr);

        const set = new Set();

        for (const branch of template.branches) {
            if (branch.absolute) {
                for (const n of this._evaluatePattern(branch, root))
                    set.add(n);
            }
            else {
                // relative branches are context-dependent: evaluate
                // the branch with every node (plus the document
                // itself) as context, collecting every node selected.
                // a node matches iff it appears in this union, which
                // anchors the pattern anywhere in the tree, exactly
                // as xslt match patterns behave.
                const doc =
                    root.nodeType === 9 ? root : root.ownerDocument;
                for (const n of this._evaluatePattern(branch, doc))
                    set.add(n);
                for (const context of this._walk(doc))
                    for (const n of
                        this._evaluatePattern(branch, context))
                        set.add(n);
            }
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

    // find the best-matching template for a node: highest §5.5
    // priority; ties break to the most recently registered, which
    // falls out of Map insertion order (later entries iterated
    // later), per XSLT 1.0 conflict recovery
    bestMatch (node, root) {
        let best = null;
        for (const t of this.templates.values()) {
            const set = this._matchSet(t, root);
            if (!set.has(node)) continue;
            const p = t.getPriority();
            // strictly greater only: an equal-priority template
            // encountered later supersedes only by iteration order,
            // which IS registration order
            if (!best || p > best.p) best = { t, p };
        }
        return best ? best.t : null;
    }

    // transform a node in place: find its best-matching template, hand
    // its body a fresh Context (params yoked at mint), and replace the
    // node with the result. all DOM assembly happens here, via MARKUP.
    transform (node, params) {
        const ctx  = new Context(this, node, params);
        const spec = ctx.applyTemplates('self::node()');

        // args carries the Context so nested spec callbacks receive it
        // (as `this` for plain functions, as the first argument
        // otherwise); MARKUP returns the last node added
        return MARKUP({ replace: node, spec: spec, args: [ctx] });
    }
}
