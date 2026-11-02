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

  The registry memoizes matches per node — `WeakMap(node,
  Set(templates))`, called `#matches` — computed ON DEMAND rather
  than by a preemptive whole-tree scan. The pattern rewriting
  (see `Template` and `pattern.js`) is what makes on-demand
  matching possible: a rewritten branch's expression, evaluated
  from a context C, nets only filtered children (or attributes)
  of C — predicates filter, they never widen netting — so for a
  candidate node exactly ONE context can net it, and that context
  is classifiable at compile time from the branch's final step
  (see `classifyBranch` in `pattern.js`):

  * `root` — absolute branches (`/…`, `//…`, `id('…')`): the
    netted set is evaluated once per root per call (memoized in
    `#rootSets`) and membership-checked per candidate
  * `self` — the bare `.` pattern: evaluated from the candidate
    itself, which nets it iff it can serve as an XPath context
    (an element or document)
  * `owner` — a final step on the attribute axis (`@href`, and
    `a/@href` rewritten to `@href[parent::a]`): evaluated from
    the candidate's `ownerElement`
  * `parent` — a final step on the child axis (the overwhelming
    majority: bare names, `text()`, `comment()`,
    `processing-instruction(…)`, every rewritten multi-step
    branch): evaluated from the candidate's `parentNode` — which
    is the old parent-as-context scan's property, preserved:
    text, comment, PI, and attribute nodes are still netted from
    their parents and remain genuinely matchable
  * `scan` — the leftovers whose netting escapes the ancestor
    chain: the bare `..`, or multi-step branches ending in a
    self/parent step that the rewrite leaves verbatim (`a/..`,
    `a/.`-style tails). These keep a per-root netted set computed
    by a walk over the root's tree — but ONLY over the
    scan-class strings, and memoized per root per call. (The
    rewrite postdates the old whole-tree scan; the scan survives
    only for these rare upward-netting forms.)

  `getMatchingTemplates(node, mode?)` therefore computes the
  matching set for a node in one pass over the collated index
  (absolutes first, then the collated Map in registration order —
  reproducing the retired scan's Set insertion order exactly, so
  the stable priority sort keeps first-registered-wins ties),
  dispatching each collated entry to its class's context, then
  filters by mode and sorts by priority. The per-node memo is
  dropped at the start of every `transform()` (the DOM mutates
  during transforms) and on every registration — the same reset
  contract the old per-root index had, but strictly fresher:
  each node's entry is computed at its first touch, so nodes
  created mid-transform (or after a registration) match
  correctly, where the old engine silently missed them.

  A corollary: cost is proportional to the nodes actually
  matched, not the whole document — a fetched `document()` costs
  nothing until its nodes are matched, and then only per
  candidate. Another: detached nodes with an element parent match
  on demand (the old walk covered only the ownerDocument's tree);
  a candidate whose `parentNode` is a DocumentFragment still
  does not match, since the parent-class guard requires an
  element/document parent.

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
  ties (first-registered wins). With the `{ identity: true }`
  constructor option (§7.5), the `*`/`/` bodies become the
  shallow-copy form (`#tag` with the qualified name, attributes,
  and namespace declarations) and comment/PI are preserved. This
  constructor-only, default-mode-only installation deliberately
  diverges from §5.8's every-mode rule: a node transformed in a
  non-default mode with no matching template hits the fallback
  below rather than a built-in.

  The matching engine hands `Context.applyTemplates` a node-set;
  each netted node is routed through the registry uniformly (any
  node kind). A node with no matching template in the active mode
  hits the fallback: elements and documents recurse into their
  children (like the built-in element rule), and non-elements
  produce nothing. There is no deep-copy pass-through and no
  special-cased structural dispatch: the built-ins ARE templates,
  so the same routing that selects them selects user templates.
  DocumentType nodes are never netted by any XPath node test, so
  they hit the non-element side of the fallback and drop, uniformly.

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
import { NamespaceMap, DEFAULT_PREFIX, defaultNamespaceURI }
  from './namespaces.js';
import { Context } from './context.js';
import { isDefaultNamespaced } from './expressions.js';

// the qualified name to emit for an identity-copied element. the
// HTML parser reports tagName/nodeName UPPERCASED and localName
// lowercased, while the XML parser preserves case — and
// markup-mixup's ELEMENT picks createElementNS over createElement
// whenever the insertion point binds the empty prefix (always in an
// HTML document, whose elements carry the XHTML namespaceURI).
// createElementNS never case-folds — only createElement does — so a
// raw tagName yields an XHTML-namespaced element named 'P', an
// HTMLUnknownElement, instead of the 'p' the parser actually
// reported. localName is the case the source document carries for
// unprefixed elements; a PREFIXED element keeps its full QName
// (nodeName): #identityElement re-states the in-scope xmlns:*
// declarations that bind the prefix, so markup-mixup creates it
// namespaced correctly.
const qualifiedName = (node) =>
    node.nodeName.indexOf(':') >= 0 ? node.nodeName : node.localName;

export class Transform {

    // see the constructor comments for what these hold
    #matches;
    #rootSets;
    #collated;
    #collatedAbsolute;
    #expressions;
    #evaluator;
    // the synthetic `_` prefix for unprefixed name tests, or null
    // when patterns must not be rewritten (no default namespace, or
    // the collision rule fired)
    #rewritePrefix;
    // the registration-time collision result: a USER-declared `_`
    // binding is in effect (an xmlns:_ in scope on the ambient
    // root, or a `_` key in the explicit map), which wins over the
    // synthetic one and disables the rewrite everywhere
    #userUnderscore;

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

    // the identity element/root rule per §7.5: shallow copy — the
    // qualified name, the attributes, any namespace declarations,
    // and the processed children — via markup-mixup's #tag
    // designator. this is what { identity: true } installs in place
    // of the default bodies.
    static #identityElement = function (ctx) {
        const node = ctx.node;

        // documents and fragments have no name to copy: their
        // children stand alone (the / rule is reachable through
        // applyTemplates over document-valued select() results)
        if (node.nodeType !== 1) return ctx.applyTemplates();

        // namespace-less elements cannot ride the #tag path: a
        // spec is evaluated against the insertion point, and
        // markup-mixup has no spelling for a no-namespace element
        // (binding xmlns='' sets ns[''] to a falsy string, which
        // still takes the unbound-prefix branch — correct in an
        // xml document, but in an HTML host document it yields
        // the XHTML namespace). assemble such elements directly
        // in the source document, then process the children
        // through MARKUP
        if (!node.namespaceURI)
            return Transform.#identityNoNS(ctx);

        const out = { '#tag': [qualifiedName(node)] };
        // attributes (markup-mixup emits xmlns declarations first,
        // then the rest alphabetically)
        const attrs = ctx.getAttributes();
        for (const k of Object.keys(attrs)) out[k] = attrs[k];
        // namespace declarations: markup-mixup binds prefixes from
        // the INSERTION point upward (gatherNS), not from the
        // source tree, so the source's in-scope declarations must
        // be re-stated explicitly or prefixed descendants lose
        // their bindings. nearest declaration wins, per XML
        // scoping
        for (let cur = node; cur && cur.nodeType === 1;
            cur = cur.parentNode)
            if (cur.attributes)
                for (const a of cur.attributes)
                    if (a.name === 'xmlns' || a.prefix === 'xmlns')
                        if (!(a.name in out)) out[a.name] = a.value;
        // the children ride the #tag array: null (nothing netted)
        // must not reach the concat, hence the || []
        out['#tag'] = out['#tag']
          .concat(ctx.applyTemplates() || []);
        return out;
    };

    // namespace-less element assembly for identity mode (see the
    // #identityElement comment): create the element directly in
    // the source document, then process the children through
    // MARKUP under it as the parent (its doc governs, so
    // namespace-less descendants land correctly too)
    static #identityNoNS = function (ctx) {
        const node = ctx.node;
        const el = ctx.doc.createElement(qualifiedName(node));
        for (const a of node.attributes) {
            if (a.prefix === 'xmlns' || a.name === 'xmlns')
                el.setAttributeNS('http://www.w3.org/2000/xmlns/',
                    a.name, a.value);
            else el.setAttribute(a.name, a.value);
        }
        MARKUP({ parent: el, spec: ctx.applyTemplates(), args: [ctx] });
        return el;
    };

    // the identity comment rule: preserve the comment
    static #identityComment = function (ctx) {
        return { '#comment': ctx.node.data };
    };

    // the identity processing-instruction rule: preserve the PI
    // through markup-mixup's #processing-instruction designator
    // ([target, data] shape). an empty attrs map flattens to ''
    // since markup-mixup's flatten fix, so a bare [target, data]
    // spec carries the data clean
    static #identityPI = function (ctx) {
        return { '#processing-instruction':
            [ctx.node.target, ctx.node.data] };
    };

    constructor (namespaces, { identity = false } = {}) {
        this.namespaces = new NamespaceMap(namespaces);

        // derive mappings from the document root if nothing was given
        if (!namespaces && typeof document !== 'undefined' &&
            document.documentElement)
            this.namespaces.derive(document.documentElement);

        // compute the pattern rewrite prefix ONCE, from the
        // registration-time ambient document (or the explicit map):
        // the synthetic `_` when a default namespace is in effect —
        // an unprefixed xmlns on the document root, or a non-empty
        // empty-prefix binding in an explicit map — and falsy
        // otherwise, so unprefixed name tests keep their native
        // XPath 1.0 semantics (matching namespace-less elements).
        // collision rule: a USER-DECLARED `_` — an xmlns:_ in scope
        // on the root, or a `_` key in the explicit map — WINS and
        // disables the rewrite, so the user's own `_:foo` patterns
        // mean what they declared. derive() already skips its
        // forced `_` binding when one is present, and its `''`
        // binding survives here for the explicit-map read.
        let defaultURI = null;
        if (namespaces) {
            const explicit = namespaces instanceof Map ?
                namespaces.get('') : namespaces[''];
            if (explicit) defaultURI = explicit;
        }
        else if (typeof document !== 'undefined' &&
            document.documentElement)
            defaultURI = defaultNamespaceURI(document);

        // a user `_` in effect anywhere in the map stands the
        // rewrite down
        this.#userUnderscore = this.namespaces.has(DEFAULT_PREFIX) &&
            this.namespaces.get(DEFAULT_PREFIX) !== defaultURI;
        this.#rewritePrefix =
            defaultURI && !this.#userUnderscore ? DEFAULT_PREFIX : null;

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
        // registered wins. identity mode (§7.5) swaps the element
        // and root bodies for the shallow-copy form and preserves
        // comments and PIs.
        this.registerMatch('*', identity ?
            Transform.#identityElement : Transform.#builtinElement);
        this.registerMatch('/', identity ?
            Transform.#identityElement : Transform.#builtinRoot);
        this.registerMatch('text()', Transform.#builtinText);
        this.registerMatch('comment()', identity ?
            Transform.#identityComment : Transform.#builtinComment);
        this.registerMatch('processing-instruction()', identity ?
            Transform.#identityPI : Transform.#builtinPI);

        // the per-node match memo: WeakMap(node, Set(templates)),
        // computed on demand per candidate (see the class comment
        // for the on-demand matching design) and dropped at the
        // start of every transform() and on every registration —
        // transforms mutate the DOM, so first-touch freshness is
        // the staleness contract
        this.#matches = new WeakMap();

        // netted sets for root- and scan-class branches:
        // WeakMap(root, Map(exprString, Set(nodes))). root-class
        // sets are computed once per root per call; scan-class sets
        // (the .. forms) walk the root's tree per the retired
        // #walk's algorithm, over scan-class expressions only
        this.#rootSets = new WeakMap();

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
    // string in a document. public because Context leans on the
    // same cache for select()/test(); the per-document resolver
    // lives in #getExpression.
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
        const t = new Template({ match, fn, mode, priority, name,
            prefix: this.#rewritePrefix });

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
        // the memos are stale too: a new template changes what any
        // node matches
        this.#matches = new WeakMap();
        this.#rootSets = new WeakMap();
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

    // the effective default-namespace state for a document: the
    // synthetic `_` rewrite is in effect when the evaluation
    // document actually carries a default namespace (per the
    // isDefaultNamespaced gate — the same single source for the
    // decision in patterns and expressions), UNLESS the
    // registration-time collision rule fired (a user-declared `_`:
    // an xmlns:_ in scope, or a `_` key in the explicit map), in
    // which case neither patterns nor expressions are rewritten.
    // this is deliberately a per-EVALUATION-DOCUMENT decision: a
    // template transforming nodes fetched via ctx.document() (an
    // Atom feed, an SVG) gets `entry`/`circle` rewritten against
    // THAT document's default namespace, whether or not the
    // registry was built on a default-namespaced ambient document.
    effectiveDefaultPrefix (doc) {
        if (this.#userUnderscore) return null;
        if (!doc || !doc.documentElement) return null;
        return isDefaultNamespaced(doc) ? DEFAULT_PREFIX : null;
    }

    // get (or create) a compiled XPathExpression for an expression
    // string in a document, via #evaluator.createExpression with a
    // PER-DOCUMENT namespace resolver: the registry's bindings
    // merged with derive(doc.documentElement) — first-wins, so a
    // document's own prefix declarations survive the merge — plus
    // `_` bound to that document's default-namespace URI, so
    // expressions rewritten per evaluation document (a template
    // transforming nodes fetched via ctx.document() — an Atom
    // feed, an SVG — resolve `_:entry` against THAT document's
    // namespace, not the ambient one). under the collision rule
    // the forced binding is skipped: the user-declared `_` rides
    // the merge untouched. this front-loads the expression parse
    // to once per (expression, document) instead of once per
    // evaluate() call, and surfaces expression errors at first
    // use — consistent with fail-at-registration.
    #getExpression (string, doc) {
        let byExpr = this.#expressions.get(doc);
        if (!byExpr) {
            byExpr = new Map();
            this.#expressions.set(doc, byExpr);
        }
        if (!byExpr.has(string))
            byExpr.set(string, this.#evaluator.createExpression(
                string, this.#docResolver(doc)));
        return byExpr.get(string);
    }

    // resolver for a specific evaluation document: the registry
    // bindings overlaid with the document's own declarations and
    // the document's default namespace bound to `_` (unless the
    // document, or the registry's map, already declares its own
    // `_` — the collision rule). the empty-prefix entry never
    // reaches the resolver; its only role was feeding the forced
    // `_`, so both are dropped before deriving, letting the
    // document's own declarations (an xmlns:_ included) land
    // first-wins
    #docResolver (doc) {
        const merged = new NamespaceMap();
        merged.absorb(this.namespaces);
        const elem = doc && doc.documentElement;
        if (elem && typeof elem.getAttribute === 'function') {
            // `''` is never consulted by the resolver; drop it so
            // derive() does not re-derive a forced `_` from the
            // registry's inherited default-namespace entry
            merged.delete('');
            // drop the FORCED `_` only: when the registry map
            // carries a USER-declared `_` (a different URI), it
            // rides the merge untouched
            if (this.namespaces.get(DEFAULT_PREFIX) ===
                this.namespaces.get(''))
                merged.delete(DEFAULT_PREFIX);
            // first-wins: a document's own declarations survive,
            // including its own xmlns:_
            merged.derive(elem);
            // the synthetic `_`: the EVALUATION document's default
            // namespace when it has one; otherwise fall back to the
            // REGISTRY's own default URI, so patterns rewritten at
            // registration time (`_:name`, against the registry's
            // ambient document or explicit map) stay RESOLVABLE
            // when matched against a different, non-default-
            // namespaced document — they may net nothing there
            // (cross-document limitation, per the README), but they
            // must not crash the evaluator. under the collision
            // rule a user `_` rides the merge and the fallback
            // stands down.
            const uri = defaultNamespaceURI(doc) ||
                this.namespaces.get('');
            if (uri && !this.#userUnderscore &&
                !merged.has(DEFAULT_PREFIX))
                merged.set(DEFAULT_PREFIX, uri);
        }
        return merged.resolver();
    }

    // collate the registered match templates into a compiled
    // expression index: Map of expression string ->
    // { string, templates: Set(Template), match }, deduplicating
    // semantically identical expressions (the first Template's
    // compiled copy is canonical; templates sharing a string share
    // its classification, since identical rewritten expressions
    // have identical shape). absolute and id() branches are set
    // aside for root testing. rebuilt lazily after any
    // registration.
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
                    entry = { string, templates: new Set(),
                        match: b.match };
                    byString.set(string, entry);
                }
                entry.templates.add(t);
            }
        }
        this.#collatedAbsolute = absolutes;
        this.#collated = byString;
        return byString;
    }

    // the netted set for a root- or scan-class expression, cached
    // per root per call: WeakMap(root, Map(exprString, Set)) —
    // WeakMap values cannot hold primitives, so the inner Map
    // carries the exprString → Set entries. root-class sets are
    // evaluated once against the root; scan-class sets (the rare
    // upward-netting .. forms) are computed by walking the root's
    // tree, at each visited element/document evaluating ONLY the
    // scan-class expressions, per the retired preemptive scan's
    // algorithm — correct by construction for the forms whose
    // netting escapes the ancestor chain
    #rootSet (root, string, scanStrings) {
        let byExpr = this.#rootSets.get(root);
        if (!byExpr) {
            byExpr = new Map();
            this.#rootSets.set(root, byExpr);
        }
        if (byExpr.has(string)) return byExpr.get(string);

        const set = new Set();
        if (scanStrings) {
            // scan class: visit every element/document in the
            // root's tree as context, netting only this expression
            const visit = (node) => {
                if (node.nodeType === 1 || node.nodeType === 9)
                    for (const n of this.#evaluateNodes(string, node))
                        set.add(n);
                if (node.childNodes)
                    for (const child of node.childNodes) visit(child);
            };
            visit(root);
        }
        else
            for (const n of this.#evaluateNodes(string, root))
                set.add(n);
        byExpr.set(string, set);
        return set;
    }

    // compute the matching set for a node in ONE pass over the
    // collated index, in INSERTION ORDER — #collatedAbsolute first,
    // then the #collate Map in registration order — which
    // reproduces the retired scan's Set insertion order exactly, so
    // the stable priority sort keeps first-registered-wins ties as
    // a delivered invariant, not a class-order accident
    #computeMatches (node) {
        const set = new Set();

        // root class: netted once per root, membership-checked
        const root = node.ownerDocument || node;
        for (const { string, template } of this.#collatedAbsolute)
            if (this.#rootSet(root, string).has(node))
                set.add(template);

        const byString = this.#collate();
        for (const entry of byString.values()) {
            // dispatch by the branch's classification: the single
            // context the membership check runs from
            const cls = entry.match;
            if (cls === 'parent') {
                // child-axis tail: the only context that can net
                // the candidate is its parent (an XPath-acceptable
                // one, or nothing)
                const p = node.parentNode;
                if (p && (p.nodeType === 1 || p.nodeType === 9) &&
                    this.#evaluateNodes(entry.string, p)
                        .includes(node))
                    for (const t of entry.templates) set.add(t);
            }
            else if (cls === 'owner') {
                // attribute tail: the candidate's ownerElement
                if (node.nodeType === 2 && node.ownerElement &&
                    this.#evaluateNodes(entry.string,
                        node.ownerElement).includes(node))
                    for (const t of entry.templates) set.add(t);
            }
            else if (cls === 'self') {
                // the bare .: the candidate itself, iff it can
                // serve as an XPath context (element or document)
                if ((node.nodeType === 1 || node.nodeType === 9) &&
                    this.#evaluateNodes(entry.string, node)
                        .includes(node))
                    for (const t of entry.templates) set.add(t);
            }
            else {
                // scan class: the per-root brute-force set
                if (this.#rootSet(root, entry.string, true).has(node))
                    for (const t of entry.templates) set.add(t);
            }
        }
        return set;
    }

    // array of matching templates for a node in a mode (null for
    // the default), sorted by descending priority. the sort is
    // stable over the Set's insertion order, so equal priorities
    // keep REGISTRATION order: the first-registered template wins
    // ties. per XSLT 1.0 §5.4, a template only applies in its
    // own mode: no fallback to default-mode templates.
    getMatchingTemplates (node, mode = null) {
        let set = this.#matches.get(node);
        if (!set) {
            set = this.#computeMatches(node);
            this.#matches.set(node, set);
        }
        if (!set.size) return [];
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
    // a result that nets nothing DROPS the node (XSLT semantics:
    // a template body producing no output removes the node) —
    // MARKUP alone would leave the original in place, since it
    // bails on empty specs.
    transform (node, params, mode = null) {
        this.#matches = new WeakMap();
        this.#rootSets = new WeakMap();

        const ctx  = new Context(this, node, params, mode);
        const spec = ctx.applyTemplates('self::node()', null, mode);

        // nothing netted: remove the node outright. this is the
        // drop path for e.g. the built-in comment() and
        // processing-instruction() rules routed at the top level
        if (!Array.isArray(spec) || !spec.length) {
            if (node.parentNode) node.parentNode.removeChild(node);
            return null;
        }

        // args carries the Context so nested spec callbacks receive it
        // (as `this` for plain functions, as the first argument
        // otherwise); MARKUP returns the last node added
        return MARKUP({ replace: node, spec: spec, args: [ctx] });
    }
}
