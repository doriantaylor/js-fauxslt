// Expression rewriting for fauxslt: rewrite unprefixed element name
// tests in arbitrary XPath expressions to the synthetic `_` prefix
// (see namespaces.js for the convention).
//
// XPath 1.0 has no default namespace, and the platform's
// XPathEvaluator is NEVER consulted for the EMPTY prefix —
// unprefixed name tests match no-namespace elements only (verified
// empirically in Firefox and Chromium against an XML-parsed XHTML
// document; see the Phase 0 probe in test/transform.browser.test.js).
// So when a document's root carries a default namespace, the only
// uniform route to matching its unprefixed elements is to rewrite
// `body` to `_:body`, with `_` bound to the root's default-namespace
// URI in the resolver.
//
// The rewrite applies ONLY to bare NCNames in node-test position.
// Skipped verbatim: literals, numbers, function names (before `(`),
// axis names (before `::`), node-type calls (`node()`, `text()`, …)
// and name tests on the attribute/namespace axes, names after `@`,
// `$`, variable/QName prefixes (already-prefixed names,
// `*:name`/`name:*` wildcards, bare `*`), operator keywords
// (`and or div mod`) following an operand, and `.`/`..`. The hyphen
// rule: `a-b` is one name, `a - b` is subtraction. The rewrite is
// idempotent: an already-rewritten expression re-serializes
// identically.
//
// Escape hatches: an explicit prefix (`svg:circle`) matches whatever
// it is bound to; `*:name` matches any namespace — useful in
// mixed-namespace documents. A user-declared `_` binding (xmlns:_ in
// scope, or a `_` key in an explicit namespace map) wins over the
// synthetic one and disables the rewrite, so the user's own `_:foo`
// means what they declared (see namespaces.js).

// XPath operator keywords: a bare NCName following a complete
// operand can only be one of these
const OPERATOR_KEYWORDS = new Set(['and', 'or', 'div', 'mod']);

// axes whose name tests are not element name tests
const NON_ELEMENT_AXES = new Set(['attribute', 'namespace']);

const NAME = /^([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*|\*))?/;
const QNAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*|\*)?/;
const NUMBER = /^[0-9][\w.]*/;

// rewrite an XPath expression string: bare unprefixed NCNames in
// node-test position become `prefix:name`. a falsy prefix returns
// the expression unchanged. heuristic string rewriting: a malformed
// rewrite fails loudly at createExpression (the supported failure
// mode); escape hatches are explicit prefixes and `*:name`.
export function rewriteExpression (expr, prefix) {
  if (!prefix) return expr;
  const src = String(expr);
  let out = '';
  let i = 0;
  const len = src.length;

  // lexer state, the XPath 1.0 §3.7 disambiguation in miniature:
  // a bare NCName is a node test at the start of an expression,
  // after an operator, after `/`, `|`, `(`, `,`, `[` — and an
  // operator keyword only AFTER a complete operand
  let afterOperand = false;
  let axisPending = null;

  while (i < len) {
    const c = src[i];

    // literals pass through verbatim
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < len) {
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      afterOperand = true;
      continue;
    }

    // numbers pass through (and terminate operands)
    if (/[0-9]/.test(c)) {
      const m = NUMBER.exec(src.slice(i));
      out += m[0];
      i += m[0].length;
      afterOperand = true;
      continue;
    }

    // a QName — possibly two NCNames around a colon
    const m = NAME.exec(src.slice(i));
    if (m && (!afterOperand || OPERATOR_KEYWORDS.has(m[1]) ||
      axisPending)) {
      const name = m[0];

      // ...::  an axis name: pass through and remember the axis
      if (/^\s*::/.test(src.slice(i + name.length))) {
        out += name;
        i += name.length;
        axisPending = m[1];
        continue;
      }

      // ...?(   a function call: never rewritten (node-type tests
      // like node()/text() land here too)
      if (/^\s*\(/.test(src.slice(i + name.length))) {
        out += name;
        i += name.length;
        afterOperand = true;
        continue;
      }

      // a name test on a captured axis: element name tests are
      // rewritten, attribute/namespace tests are not; an
      // already-prefixed name is verbatim (idempotency)
      if (axisPending) {
        if (name.indexOf(':') !== -1 ||
          NON_ELEMENT_AXES.has(axisPending)) out += name;
        else out += prefix + ':' + name;
        i += name.length;
        axisPending = null;
        afterOperand = true;
        continue;
      }

      // already-prefixed QName or wildcard (*:name, name:*): verbatim
      if (name.indexOf(':') !== -1) {
        out += name;
        i += name.length;
        afterOperand = true;
        continue;
      }

      // operator keyword after an operand: verbatim, and the next
      // bare name is a node test again
      if (afterOperand && OPERATOR_KEYWORDS.has(m[1])) {
        out += name;
        i += name.length;
        afterOperand = false;
        continue;
      }

      // bare NCName in node-test position: the rewrite
      out += prefix + ':' + name;
      i += name.length;
      afterOperand = true;
      continue;
    }

    // `::` of an axis whose head did not lex as a name above, or a
    // stray colon (defensive; malformed input fails loudly at
    // createExpression). the axis state set by the head survives
    // the separator so the name-test branch above can consume it
    if (c === ':') {
      const two = src[i + 1] === ':';
      out += two ? '::' : ':';
      i += two ? 2 : 1;
      continue;
    }

    // the pending axis, if any, is dropped here: its name test did
    // not lex as a name in the branch above
    axisPending = null;

    // `.` or `..` — steps; verbatim, and an operand terminator
    if (c === '.') {
      out += '.';
      i++;
      if (src[i] === '.') { out += '.'; i++; }
      afterOperand = true;
      continue;
    }

    // `@` and the (optional) attribute name after it: attribute
    // name tests are never rewritten (in the HTML DOM attributes
    // are namespace-less; unprefixed attribute tests match exactly
    // that)
    if (c === '@') {
      out += '@';
      i++;
      const am = QNAME.exec(src.slice(i));
      if (am) { out += am[0]; i += am[0].length; }
      afterOperand = true;
      continue;
    }

    // `$foo` and any QName after `$`: verbatim (variable
    // references; fauxslt rejects them downstream anyway)
    if (c === '$') {
      out += '$';
      i++;
      const vm = QNAME.exec(src.slice(i));
      if (vm) { out += vm[0]; i += vm[0].length; }
      afterOperand = true;
      continue;
    }

    // `*`: bare wildcard, multiplication, or the namespace end of
    // `*:name` (the wildcard form of a prefixed name test) — all
    // verbatim. as multiplication it ends an operand; as a bare
    // wildcard it IS one — either way the next bare name lexes in
    // node-test position
    if (c === '*') {
      out += c;
      i++;
      // `*:name`: consume the other half so it does not lex as a
      // bare NCName in node-test position
      if (src[i] === ':') {
        out += ':';
        i++;
        const wm = QNAME.exec(src.slice(i));
        if (wm) { out += wm[0]; i += wm[0].length; }
      }
      afterOperand = false;
      continue;
    }

    // path separators: the next bare name is a node test
    if (c === '/' || c === '|') {
      out += c;
      i++;
      afterOperand = false;
      continue;
    }

    // subexpressions: the next bare name is a node test after `(`/`,`
    // `/[`, and an operand terminator after `)`/`]`
    if (c === '(' || c === ',' || c === '[') {
      out += c;
      i++;
      afterOperand = false;
      continue;
    }
    if (c === ')' || c === ']') {
      out += c;
      i++;
      afterOperand = true;
      continue;
    }

    // `::` whose head did not lex as a name (defensive; malformed
    // input fails loudly at createExpression)
    if (c === ':' && src[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }

    // operators, whitespace, and anything else: verbatim. whitespace
    // preserves state; operator characters end the operand state
    if (/\s/.test(c)) { out += c; i++; continue; }
    out += c;
    i++;
    afterOperand = false;
  }

  return out;
}

// does the document's root carry a default-namespace declaration?
// the gate for expression rewriting: unprefixed names are only
// rewritten (and resolved against `_`) when a default namespace
// exists. an xmlns="" undeclaration counts as no default namespace.
// a user-declared `_` prefix (an xmlns:_ in scope on the document
// root) WINS over the synthetic one and disables the rewrite — the
// collision rule from namespaces.js.
export function isDefaultNamespaced (doc) {
  const elem = doc && doc.documentElement;
  if (!elem || typeof elem.getAttribute !== 'function') return false;
  if (!elem.getAttribute('xmlns')) return false;
  for (let p = elem; p && p.nodeType === 1; p = p.parentNode)
    if (p.getAttribute && p.getAttribute('xmlns:_') != null)
      return false;
  return true;
}