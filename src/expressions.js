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
// The rewrite applies ONLY to bare NCNames in node-test position,
// per the XPath 1.0 §3.7 lexing rules:
//   * literals and numbers: verbatim
//   * a name before `(`: a function call (node-type tests like
//     text()/node() land here) — verbatim
//   * a name before `::`: an axis name — verbatim, remembered so the
//     FOLLOWING name test is rewritten only on an element axis
//   * names after `@` (including `@*`), on the attribute/namespace
//     axes, and after `$`: never rewritten (attributes are
//     namespace-less in the HTML DOM; variables are rejected
//     downstream anyway)
//   * already-prefixed QNames, `*:name`/`name:*` wildcards, and a
//     bare `*`: verbatim
//   * operator keywords (and/or/div/mod) following a complete
//     operand — including one ending in a wildcard `*`: verbatim
//   * `.`/`..`: verbatim
//   * the hyphen rule: `a-b` is one name, `a - b` is subtraction
// Whitespace may separate any of the pieces (`attribute :: href`,
// `@ href`); NCNames may carry Unicode letters (XPath 1.0 NCNames
// are Unicode, like the pattern grammar's). The rewrite is
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

// NCName per XML: Unicode letter (or underscore) first, then
// letters/digits/underscore/dot/hyphen — matching the pattern
// grammar's classes
const NAME = /^([\p{L}_][\p{L}\p{N}_.-]*)(?::([\p{L}_][\p{L}\p{N}_.-]*|\*))?/u;
const QNAME = /^[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_][\p{L}\p{N}_.-]*|\*)?/u;
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

  // lexer state, the §3.7 disambiguation in miniature:
  // afterOperand — a complete operand has just ended (the next bare
  //   name can only be an operator keyword; a `*` is
  //   multiplication); node-test position otherwise
  // axisPending — an axis name was consumed; the next name test is
  //   on that axis (whitespace may intervene)
  // starSeen — a wildcard `*` name test just ended (the next bare
  //   name can only be an operator keyword)
  let afterOperand = false;
  let axisPending = null;
  let starSeen = false;

  while (i < len) {
    const c = src[i];

    // whitespace: pass through, preserving state
    if (/\s/.test(c)) { out += c; i++; continue; }

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
      starSeen = false;
      continue;
    }

    // numbers pass through (and terminate operands)
    if (/[0-9]/.test(c)) {
      const m = NUMBER.exec(src.slice(i));
      out += m[0];
      i += m[0].length;
      afterOperand = true;
      starSeen = false;
      continue;
    }

    // a QName — possibly two NCNames around a colon
    const m = NAME.exec(src.slice(i));
    if (m && (!afterOperand && !starSeen ||
      OPERATOR_KEYWORDS.has(m[1]) || axisPending)) {
      const name = m[0];
      starSeen = false;

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
        axisPending = null;
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

      // operator keyword after an operand or wildcard: verbatim,
      // and the next bare name is a node test again
      if ((afterOperand || starSeen) &&
        OPERATOR_KEYWORDS.has(m[1])) {
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

    starSeen = false;

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

    // `@`, an (optional) attribute name or wildcard after it —
    // possibly whitespace-separated: attribute name tests are never
    // rewritten (in the HTML DOM attributes are namespace-less;
    // unprefixed attribute tests match exactly that)
    if (c === '@') {
      out += '@';
      i++;
      let rest = src.slice(i);
      const ws = /^\s*/.exec(rest)[0];
      out += ws;
      i += ws.length;
      rest = src.slice(i);
      if (rest[0] === '*') {
        out += '*';
        i++;
        // `@*:name`: consume the wildcard's other half
        rest = src.slice(i);
        const wsm = /^\s*/.exec(rest)[0];
        if (/^:/.test(rest.slice(wsm.length))) {
          out += wsm + ':';
          i += wsm.length + 1;
          const nm = QNAME.exec(src.slice(i));
          if (nm) { out += nm[0]; i += nm[0].length; }
        }
      }
      else {
        const am = QNAME.exec(rest);
        if (am) { out += am[0]; i += am[0].length; }
      }
      afterOperand = true;
      continue;
    }

    // `$foo` — a variable reference (possibly whitespace-separated):
    // verbatim; fauxslt rejects it downstream anyway
    if (c === '$') {
      out += '$';
      i++;
      const ws = /^\s*/.exec(src.slice(i))[0];
      out += ws;
      i += ws.length;
      const vm = QNAME.exec(src.slice(i));
      if (vm) { out += vm[0]; i += vm[0].length; }
      afterOperand = true;
      continue;
    }

    // `*`: bare wildcard, multiplication, or the namespace end of
    // `*:name`. per §3.7, `*` after a complete operand is
    // multiplication (an operator); otherwise it is a wildcard
    // name test, and the next bare name can only be an operator
    // keyword
    if (c === '*') {
      const multiply = afterOperand;
      out += c;
      i++;
      starSeen = !multiply;
      afterOperand = !multiply;
      // `*:name`: consume the other half so it does not lex as a
      // bare NCName in node-test position
      if (!multiply && src[i] === ':') {
        out += ':';
        i++;
        const wm = QNAME.exec(src.slice(i));
        if (wm) { out += wm[0]; i += wm[0].length; }
      }
      continue;
    }

    // path separators: the next bare name is a node test
    if (c === '/' || c === '|') {
      out += c;
      i++;
      afterOperand = false;
      continue;
    }

    // subexpressions: the next bare name is a node test after
    // `(`/`,`/`[`, and an operand terminator after `)`/`]`
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

    // operators and anything else: verbatim; operator characters
    // end the operand state
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