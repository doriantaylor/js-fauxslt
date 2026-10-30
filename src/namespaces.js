// Namespace mappings for fauxslt. The Transform needs a prefix -> URI
// map which (a) drives the native XPathEvaluator's namespace resolver
// and (b) is available to template code. When constructed without an
// explicit map, mappings are derived from document.documentElement
// (walking xmlns:* attributes up the ancestor chain), topped up with
// defaults: the xml: namespace, xmlns, and the XHTML default for
// (non-X)HTML documents, where the DOM reports unprefixed elements
// with no namespaceURI and pattern names like svg:circle or xhtml
// prefixes still need to resolve.

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

// defaults assumed present in every registry
export const DEFAULT_NAMESPACES = {
  xml: XML_NAMESPACE,
  xmlns: 'http://www.w3.org/2000/xmlns/',
};

// namespace for (non-X)HTML documents: a real default binding for the
// prefix \`html:\`, kept for prefixed usage in templates. it no longer
// drives the pattern rewrite (see DEFAULT_PREFIX).
export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
export const XHTML_PREFIX = 'html';

// the synthetic prefix spelled \`_\` (a legal NCName) that unprefixed
// element name tests are rewritten to when the document has a default
// namespace. XPath 1.0 has no default namespace: the evaluator is
// NEVER consulted for the empty prefix (operator-verified in Firefox
// and Chromium), so a document like an XHTML page, an Atom feed, or
// an SVG image — one whose root carries an unprefixed xmlns — needs
// \`body\` rewritten to \`_:body\` for the name test to match anything.
// documents WITHOUT a default namespace (HTML parsed as text/html,
// no-namespace XML) are not rewritten: unprefixed names then match
// namespace-less elements natively. collision rule: a user-declared
// \`_\` binding (an xmlns:_ attribute in scope on the document root,
// or a \`_\` key in the explicit namespace map) WINS, and the rewrite
// is disabled for that document — the user's own \`_:foo\` patterns
// and expressions mean what they declared.
export const DEFAULT_PREFIX = '_';

// the root's default-namespace URI: the value of an unprefixed xmlns
// attribute on the document element, or null when there is none. an
// EMPTY-string value (xmlns="", a default-namespace UNdeclaration)
// counts as no default namespace, so no \`_:name\` is ever resolved
// against an empty-string URI. reads the raw document, so it works
// before a Transform exists.
export function defaultNamespaceURI (doc) {
  const elem = doc && doc.documentElement;
  if (!elem || typeof elem.getAttribute !== 'function') return null;
  const val = elem.getAttribute('xmlns');
  return val ? val : null;
}

export class NamespaceMap extends Map {

  constructor (initial) {
    super(Object.entries(DEFAULT_NAMESPACES));
    // the synthetic xhtml prefix kept as a real binding
    this.set(XHTML_PREFIX, XHTML_NAMESPACE);
    if (initial) this.absorb(initial);
  }

  absorb (mappings) {
    if (!mappings) return this;
    // accept a plain object, a Map, or a NamespaceMap
    if (mappings instanceof Map) {
      for (const [k, v] of mappings) this.set(k, v);
    }
    else if (typeof mappings === 'object') {
      for (const k of Object.keys(mappings)) this.set(k, mappings[k]);
    }
    // a non-empty empty-prefix binding means the rewrite target \`_\`
    // MUST resolve to the default-namespace URI in this map: a
    // rewritten expression compiles against this very map
    this.#forceDefaultPrefix();
    return this;
  }

  // derive prefix -> URI mappings from an element's namespace context
  // (own prefix and xmlns:* attributes, plus the ancestor chain)
  derive (elem) {
    if (!elem) return this;
    if (typeof elem.getAttribute !== 'function') return this;

    // own prefix
    if (elem.namespaceURI && elem.prefix &&
      !this.has(elem.prefix))
      this.set(elem.prefix, elem.namespaceURI);

    // xmlns declarations in scope
    for (const attr of elem.attributes) {
      let m = /^xmlns(?::(.*))?$/.exec(attr.name);
      if (m) {
        const pfx = m[1] || '';
        // the empty prefix is bound too: a default xmlns declaration
        // (e.g. on an XHTML root) means unprefixed names live in
        // that namespace. the rewrite to DEFAULT_PREFIX resolves
        // through this map, so a non-empty binding forces the `_`
        // key to the same URI (unless a user-declared `_` is
        // already present — see #forceDefaultPrefix)
        if (!this.has(pfx)) this.set(pfx, attr.value);
      }
      // namespaced attributes (e.g. xlink:href) carry their own
      else if (attr.namespaceURI && attr.prefix &&
        !this.has(attr.prefix))
        this.set(attr.prefix, attr.namespaceURI);
    }

    // a default-namespace declaration was seen (possibly up the
    // chain): keep the map self-consistent for the rewrite
    this.#forceDefaultPrefix();

    // up the chain
    let p = elem.parentNode;
    while (p && p.nodeType === 1) {
      this.derive(p);
      p = p.parentNode;
    }

    return this;
  }

  // bind the synthetic `_` to the default-namespace URI whenever a
  // non-empty empty-prefix binding is present. collision rule: a
  // user-declared `_` wins — its binding is left untouched, and the
  // rewrite machinery detects it (DEFAULT_PREFIX already taken by a
  // binding that did not come from the empty-prefix entry) and
  // stands down for that document.
  #forceDefaultPrefix () {
    const uri = this.get('');
    if (!uri) return;
    // only bind when `_` is not already taken by a user
    // declaration — first-wins, same as every other derive entry
    if (!this.has(DEFAULT_PREFIX)) this.set(DEFAULT_PREFIX, uri);
  }

  // produce a resolver for XPathEvaluator.createExpression()
  resolver () {
    const self = this;
    return function resolveNamespace (prefix) {
      if (self.has(prefix)) return self.get(prefix);
      return null;
    };
  }
}
