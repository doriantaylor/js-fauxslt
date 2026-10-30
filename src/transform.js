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
    * at each visited ELEMENT or DOCUMENT, evaluate each collated
      expression in NODE-SET mode with the visited node as CONTEXT,
      and record every netted node in `#nodeMatches` (the
      parent-as-context scan). the context node is always an
      element or document — the only kinds the DOM XPath API
      accepts as context — so nodes the XPath API refuses as
      context nodes (text, comment, PI, attribute) are netted from
      their PARENTS and become genuinely matchable: `text()`,
      `comment()`, `processing-instruction()`, and `@attr` are
      ordinary matchable patterns.
    * recurse into each visited node's children (all kinds), so
      every element and document in the tree serves as context
      exactly once

  (That might be amenable to being async but we probably want to await
  it before we actually test anything against it.)

  Built-in template rules (XSLT 1.0 §5.8) are installed in the
  constructor and ONLY in the constructor, as ordinary registered
  templates in the DEFAULT mode — nothing about them is special,
  and re-registering the same pattern+mode overwrites one (that IS
  the supported override path). The rules are: `*` (element rule:
  recurse into children, no attribute copy; §5.5 priority −0.5),
  `/` (root rule; priority 0), `text()` (copy the string value),
  `comment()` (drop), and `processing-instruction()` (drop). `*` and
  `/` are registered SEPARATELY because `Template.getPriority()`
  takes the max across branches: a `*|/` union would compute
  priority 0 and beat bare-name user templates (priority 0) on
  ties (first-registered wins). This constructor-only,
  default-mode-only installation deliberately diverges from §5.8's
  every-mode rule: a node transformed in a non-default mode with no
  matching template hits the fallback below rather than a built-in.

  The matching engine hands `Context.applyTemplates` a node-set;
  each netted node is routed through the registry uniformly (any
  node kind). A node with no matching template in the active mode
  hits the fallback: elements and documents recurse into their
  children (like the built-in element rule), and non-elements
  produce nothing. There is no deep-copy pass-through and no
  special-cased structural dispatch: the built-ins ARE templates,
  so the same routing that selects them selects user templates.
  DocumentType nodes are never netted by any XPath node test, so
  they fall to the no-children fallback and drop, uniformly.

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

    // see the constructor comments for what these hold
    #nodeMatches;
    #collated;
    #collatedAbsolute;
    #expressions;
    #evaluator;

    // built-in template bodies per XSLT 1.0 §5.8. these are plain
    // functions of a Context, just like user template bodies — the
    // built-ins are registered through the ordinary registerMatch
    // path and are overwriteable by re-registration like any
    // template. static so the function identities are shared across
    // instances.

    // the default element rule: recurse into children only.
    // attributes are NOT copied — per §5.8.
    static #builtinElement = function (ctx) {
        return ctx.applyTemplates();
    };

    // the default root rule: same body as the element rule (§5.8
    // gives / and * the same body), but registered separately so
    // their priorities stay distinct (Template.getPriority takes
    // the max across branches; a combined */ union would compute
    // priority 0 and beat bare-name user templates on ties).
    static #builtinRoot = function (ctx) {
        return ctx.applyTemplates();
    };

    // the default text rule: copy the string value
    static #builtinText = function (ctx) {
        return ctx.node.data;
    };

    // the default comment rule: dropped
    static #builtinComment = function (ctx) {
        return null;
    };

    // the default processing-instruction rule: dropped
    static #builtinPI = function (ctx) {
        return null;
    };

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

        // §5.8 built-in template rules, installed in the CONSTRUCTOR
        // and only in the DEFAULT MODE, as ordinary registered
        // templates: nothing about them is special, and a user
        // re-registering the same pattern+mode overwrites one. this
        // diverges from §5.8, which installs the rules in EVERY
        // mode — deliberate, documented in the README. registering
        // * and / as separate patterns (not *|/) keeps their
        // priorities distinct: getPriority takes the max across
        // branches, so a union would compute 0 and beat bare-name
        // user templates (priority 0) on ties, where first-
        // registered wins.
        this.registerMatch('*', Transform.#builtinElement);
        this.registerMatch('/', Transform.#builtinRoot);
        this.registerMatch('text()', Transform.#builtinText);
        this.registerMatch('comment()', Transform.#builtinComment);
        this.registerMatch('processing-instruction()',
            Transform.#builtinPI);

        // the node-match index, per spec: WeakMap(root, WeakMap(node,
        // Set(templates))), populated lazily by #walk at the beginning
        // of transform(). keyed by root so unbound nodes, document
        // fragments, and multiple documents each get their own index.
        this.#nodeMatches = new WeakMap();

        // collated compiled expressions for the scan: Map of
        // xpath-string -> { expr, templates: Set(Template) }, built
        // once per registration state, reused across transforms.
        // absolute and id() branches are set aside for root testing.
        this.#collated = null;
        this.#collatedAbsolute = [];

        // compiled XPathExpression cache, keyed weakly by document (a
        // registry can serve multiple documents; the expressions
        // themselves are reusable across transforms, so they outlive
        // the per-transform match cache and are only held while the
        // document lives). a single XPathEvaluator instance serves all
        // documents.
        this.#expressions = new WeakMap();
        this.#evaluator = typeof XPathEvaluator === 'function' ?
            new XPathEvaluator() : null;
    }

    // get (or create) a compiled XPathExpression for an expression
    // string in a document, via #evaluator.createExpression with the
    // embedded namespace mapping. this front-loads the expression
    // parse to once per (expression, document) instead of once per
    // evaluate() call, and surfaces expression errors at first use —
    // consistent with fail-at-registration.
    #getExpression (string, doc) {
        let byExpr = this.#expressions.get(doc);
        if (!byExpr) {
            byExpr = new Map();
            this.#expressions.set(doc, byExpr);
        }
        if (!byExpr.has(string))
            byExpr.set(string, this.#evaluator.createExpression(
                string, this.nsResolver()));
        return byExpr.get(string);
    }

    // get (or create) a compiled XPathExpression for an expression
    // string in a document, via #evaluator.createExpression with the
    // embedded namespace mapping. this front-loads the expression
    // parse to once per (expression, document) instead of once per
    // evaluate() call, and surfaces expression errors at first use —
    // consistent with fail-at-registration. public because Context
    // leans on the same cache for select()/test().
    compiledExpression (string, doc) {
        return this.#getExpression(string, doc);
    }

    // evaluate a node-set expression from a context node, returning
    // an array of the nodes netted (snapshot semantics)
    #evaluateNodes (string, node) {
        const doc = node.ownerDocument || node;
        const expr = this.#getExpression(string, doc);
        const r = expr.evaluate(node,
                                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < r.snapshotLength; i++)
            out.push(r.snapshotItem(i));
        return out;
    }

    // register a template against a match pattern. the pattern is
    // compiled (validated) immediately; invalid syntax throws here.
    // the third argument is polyvalent: an options object
    // { mode?, priority?, name? } or a mode string, with priority
    // and name following positionally. re-registering the same
    // pattern+mode overwrites.
    registerMatch (match, fn, opts) {
        let mode = null, priority = null, name = null;
        if (typeof opts === 'string') mode = opts;
        else if (typeof opts === 'number') priority = opts;
        else if (opts && typeof opts === 'object') {
            mode = opts.mode || null;
            priority = opts.priority;
            name = opts.name || null;
        }
        const t = new Template({ match, fn, mode, priority, name });

        // the pattern map is keyed by pattern, then by mode: a
        // pattern is really a pattern-mode pair
        let byMode = this.templates.get(t.pattern);
        if (!byMode) {
            byMode = new Map();
            this.templates.set(t.pattern, byMode);
        }
        byMode.set(mode, t);

        // a named registration alongside the pattern keys the name
        // map too (a template may key on both)
        if (name) this.named.set(name, t);

        // the collated expression index is stale: rebuild on demand
        this.#collated = null;
        return t;
    }

    // register a named template. named templates are modeless, per
    // XSLT: callTemplate does not take a mode.
    registerNamed (name, fn) {
        const t = new Template({ name, fn });
        this.named.set(name, t);
        return t;
    }

    // namespace resolver for the native evaluator
    nsResolver () {
        return this.namespaces.resolver();
    }

    // collate the registered match templates into a compiled
    // expression index: Map of expression string ->
    // { string, templates: Set(Template) }, deduplicating
    // semantically identical expressions (the first Template's
    // compiled copy is canonical). absolute and id() branches are set
    // aside for root testing. rebuilt lazily after any registration.
    #collate () {
        if (this.#collated) return this.#collated;
        const byString = new Map();
        const absolutes = [];
        // this.templates maps pattern -> Map(mode -> Template)
        for (const byMode of this.templates.values())
        for (const t of byMode.values()) {
            for (const b of t.branches || []) {
                const string = b.evalExpr;
                if (b.absolute) {
                    absolutes.push({ string, template: t, branch: b });
                    continue;
                }
                let entry = byString.get(string);
                if (!entry) {
                    entry = { string, templates: new Set() };
                    byString.set(string, entry);
                }
                entry.templates.add(t);
            }
        }
        this.#collatedAbsolute = absolutes;
        this.#collated = byString;
        return byString;
    }

    // populate #nodeMatches for a root, per the spec's algorithm:
    // walk the tree from the root and, at each visited ELEMENT or
    // DOCUMENT, evaluate every collated expression in NODE-SET mode
    // with the visited node as CONTEXT, recording every netted node
    // (the parent-as-context scan). the context is always an element
    // or document — the only kinds the DOM XPath API accepts — so
    // patterns netting text, comment, PI, or attribute nodes are
    // evaluated from each node's parent and the match is recorded
    // against the netted node itself. this makes node-test patterns
    // (text(), comment(), processing-instruction()) and attribute
    // patterns (@attr) genuinely matchable. each rewritten expression
    // nets each node exactly once (at its parent), so the cost
    // profile matches the earlier per-candidate scan. absolute and
    // id() branches are tested once against the root.
    #walk (root) {
        if (this.#nodeMatches.has(root))
            return this.#nodeMatches.get(root);

        const byNode = new WeakMap();
        this.#nodeMatches.set(root, byNode);

        const byString = this.#collate();

        // record a match
        const record = (node, t) => {
            let set = byNode.get(node);
            if (!set) {
                set = new Set();
                byNode.set(node, set);
            }
            set.add(t);
        };

        // absolute and id() branches net their nodes from the root
        for (const { string, template } of this.#collatedAbsolute)
            for (const n of this.#evaluateNodes(string, root))
                record(n, template);

        // visit every node in document order, evaluating each
        // collated expression with each visited ELEMENT or DOCUMENT
        // as context and recording every node it nets: XPath 1.0
        // only accepts documents and elements as context nodes, so
        // text, comments, etc. cannot serve as context — but they
        // are netted from their parents, which is what makes them
        // matchable. all nodes are still visited so their element
        // children are reached.
        const visit = (node) => {
            const testable = node.nodeType === 1 || node.nodeType === 9;
            if (testable) {
                for (const entry of byString.values())
                    for (const n of
                        this.#evaluateNodes(entry.string, node))
                        for (const t of entry.templates) record(n, t);
            }
            if (node.childNodes)
                for (const child of node.childNodes) visit(child);
        };
        // begin at the root: unbound elements are provisionally
        // bound to the root they were reached through (fragments
        // included)
        visit(root);

        return byNode;
    }

    // array of matching templates for a node in a mode (null for
    // the default), sorted by descending priority. the sort is
    // stable over the Set's insertion order, so equal priorities
    // keep REGISTRATION order: the first-registered template wins
    // ties. per XSLT 1.0 §5.4, a template only applies in its
    // own mode: no fallback to default-mode templates.
    getMatchingTemplates (node, mode = null) {
        const root = node.ownerDocument || node;
        const byNode = this.#walk(root);
        const set = byNode.get(node);
        if (!set || !set.size) return [];
        return Array.from(set)
            .filter(t => t.mode === mode)
            .sort((a, b) => b.getPriority() - a.getPriority());
    }

    // the single best template for a node in a mode: highest
    // priority, first-registered wins ties
    getMatchingTemplate (node, mode = null) {
        const ts = this.getMatchingTemplates(node, mode);
        return ts.length ? ts[0] : null;
    }

    // transform a node in place: find its best-matching template, hand
    // its body a fresh Context (params yoked at mint), and replace the
    // node with the result. all DOM assembly happens here, via MARKUP.
    // the node-match index is per document state: transforms mutate
    // the DOM, so it is dropped and rebuilt lazily on each call.
    transform (node, params, mode = null) {
        this.#nodeMatches = new WeakMap();

        const ctx  = new Context(this, node, params, mode);
        const spec = ctx.applyTemplates('self::node()', null, mode);

        // args carries the Context so nested spec callbacks receive it
        // (as `this` for plain functions, as the first argument
        // otherwise); MARKUP returns the last node added
        return MARKUP({ replace: node, spec: spec, args: [ctx] });
    }
}
