// Namespace mappings for fauxslt. The Registry keeps a prefix -> URI
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

// namespace for (non-X)HTML documents: unprefixed element name tests
// in match patterns are rewritten to this synthetic prefix at compile
// time (XPath 1.0 has no default namespace, and XPathEvaluator's
// never consults the resolver for unprefixed names), bound here to
// XHTML so one pattern matches both HTML and XHTML documents.
export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
export const XHTML_PREFIX = 'html';

export class NamespaceMap extends Map {

  constructor (initial) {
    super(Object.entries(DEFAULT_NAMESPACES));
    // the synthetic xhtml prefix used by the pattern rewriter
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
        // that namespace. XPath 1.0 semantics mean the evaluator
        // won't consult the resolver for unprefixed names — the
        // compile-time html: rewrite does the actual matching — but
        // the binding keeps the map correct for XHTML and available
        // to anything else that consumes the resolver.
        if (!this.has(pfx)) this.set(pfx, attr.value);
      }
      // namespaced attributes (e.g. xlink:href) carry their own
      else if (attr.namespaceURI && attr.prefix &&
        !this.has(attr.prefix))
        this.set(attr.prefix, attr.namespaceURI);
    }

    // up the chain
    let p = elem.parentNode;
    while (p && p.nodeType === 1) {
      this.derive(p);
      p = p.parentNode;
    }

    return this;
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
