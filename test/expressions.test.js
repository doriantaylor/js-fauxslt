// Unit tests for the expression rewriter and the default-namespace
// gate: the `_:name` rewrite matrix and the isDefaultNamespaced stub
// legs. Pure JS (stub document objects), so node:test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteExpression, isDefaultNamespaced }
  from '../src/expressions.js';

// --- node-test position: rewritten to _:name -----------------------
const rw = (expr, expected) => () =>
  assert.equal(rewriteExpression(expr, '_'), expected);

test('rewrites rooted paths', rw('/html/head/title',
  '/_:html/_:head/_:title'));
test('rewrites inside function calls', rw('count(//li)',
  'count(//_:li)'));
test('rewrites deep paths', rw('//div', '//_:div'));
test('rewrites steps after . and //', rw('.//main[not(@hidden)][1]',
  './/_:main[not(@hidden)][1]'));
test('rewrites axis name tests', rw('child::main', 'child::_:main'));
test('rewrites inside predicates', rw('a/b[c][2]',
  '_:a/_:b[_:c][2]'));
test('rewrites bare names in unions', rw('a | b', '_:a | _:b'));

// --- the hyphen rule ------------------------------------------------
test('hyphen rule: a - b is subtraction', rw('a - b', '_:a - _:b'));
test('hyphen rule: foo-bar is one name', rw('foo-bar', '_:foo-bar'));

// --- operator keywords ----------------------------------------------
test('operator keywords after an operand stay verbatim',
  rw('a div b', '_:a div _:b'));
test('and/or/mod stay verbatim', rw('a and b or c mod d',
  '_:a and _:b or _:c mod _:d'));

// --- skipped verbatim -----------------------------------------------
test('attributes are never rewritten', rw('@href', '@href'));
test('attribute axis tests are never rewritten',
  rw('attribute::href', 'attribute::href'));
test('namespace axis tests are never rewritten',
  rw('namespace::href', 'namespace::href'));
test('attribute comparisons stay verbatim',
  rw("@class = 'draft'", "@class = 'draft'"));
test('prefixed names stay verbatim', rw('svg:circle', 'svg:circle'));
test('any-namespace wildcard stays verbatim', rw('*:para', '*:para'));
test('namespace wildcard stays verbatim', rw('li:*', 'li:*'));
test('bare wildcard stays verbatim', rw('*', '*'));
test('function names stay verbatim', rw('text()', 'text()'));
test('node-type calls stay verbatim', rw('node()', 'node()'));
test('processing-instruction literals stay verbatim',
  rw("processing-instruction('x')", "processing-instruction('x')"));
test('numeric predicates stay verbatim', rw('position() = 2',
  'position() = 2'));
test('string functions over . stay verbatim',
  rw("substring-before(., 'div')", "substring-before(., 'div')"));
test('self::node() stays verbatim', rw('self::node()', 'self::node()'));
test('literals stay verbatim', rw("'a-b'", "'a-b'"));
test('numbers stay verbatim', rw('1 + 2', '1 + 2'));
test('multiplication stays verbatim', rw('2*3', '2*3'));
test('dot and dotdot stay verbatim', rw('. - 1', '. - 1'));
test('element paths into attributes rewrite only the element',
  rw('p/@id', '_:p/@id'));

// --- idempotency ------------------------------------------------------
test('rewrite is idempotent', () => {
  for (const expr of ['/html/head/title', 'count(//li)',
    './/main[not(@hidden)][1]', 'a - b', 'foo-bar',
    "para[@class = 'draft']", 'svg:circle | *:para',
    'normalize-space(/html/head/title)'])
    assert.equal(rewriteExpression(rewriteExpression(expr, '_'), '_'),
      rewriteExpression(expr, '_'));
});

// --- operator keywords after a wildcard --------------------------------
// per XPath 1.0 §3.7 a bare name following a wildcard name test can
// only be an operator keyword — never a node test
test('keywords after @* stay verbatim', rw('p[@* and @id]',
  '_:p[@* and @id]'));
test('keywords after a bare wildcard stay verbatim',
  rw('entry[* or @id]', '_:entry[* or @id]'));
test('keywords after *:para stay verbatim', rw('*:para and @id',
  '*:para and @id'));
test('keywords after @* as a step stay verbatim', rw('@* and b',
  '@* and _:b'));
test('multiplication keeps operator position', rw('2 * 3', '2 * 3'));
test('keywords after count(*) stay verbatim', rw('count(*) and @x',
  'count(*) and @x'));
test('wildcard then keyword then name', rw('a and * and b',
  '_:a and * and _:b'));

// --- whitespace-separated forms ---------------------------------------
test('whitespace after an axis separator', rw('attribute :: href',
  'attribute :: href'));
test('whitespace between axis and its test',
  rw('attribute:: href', 'attribute:: href'));
test('whitespace on the namespace axis', rw('namespace :: p',
  'namespace :: p'));
test('whitespace after @', rw('@ href', '@ href'));
test('whitespace after $', rw('$ foo', '$ foo'));
test('whitespace-separated element axis still rewrites',
  rw('child :: main', 'child :: _:main'));

// --- non-ASCII NCNames -------------------------------------------------
test('accented names are one NCName', rw('café', '_:café'));
test('non-ASCII-initial names are one NCName', rw('élément',
  '_:élément'));
test('non-ASCII names in paths', rw('a//café', '_:a//_:café'));

// --- falsy prefix: pass-through ---------------------------------------
test('falsy prefix returns the expression unchanged', () => {
  const expr = '/html/head/title';
  assert.equal(rewriteExpression(expr, null), expr);
  assert.equal(rewriteExpression(expr, ''), expr);
  assert.equal(rewriteExpression(expr), expr);
});

// --- isDefaultNamespaced stub matrix ---------------------------------
// stub elements carry attributes as a plain map
const el = (attrs = {}) => ({
  nodeType: 1,
  parentNode: null,
  getAttribute (n) {
    return Object.prototype.hasOwnProperty.call(attrs, n) ?
      attrs[n] : null;
  },
});

test('isDefaultNamespaced: xhtml+xml root with unprefixed xmlns', () => {
  const doc = { documentElement: el({
    xmlns: 'http://www.w3.org/1999/xhtml' }) };
  assert.equal(isDefaultNamespaced(doc), true);
});

test('isDefaultNamespaced: text/html root without xmlns', () => {
  const doc = { documentElement: el({}) };
  assert.equal(isDefaultNamespaced(doc), false);
});

test('isDefaultNamespaced: text/html root WITH xmlns=xhtml (polyglot)',
  () => {
    // a polyglot document parsed as text/html still carries the
    // raw xmlns attribute, which the DOM preserves: the helper
    // reads the attribute, not namespaceURI
    const doc = { documentElement: el({
      xmlns: 'http://www.w3.org/1999/xhtml' }) };
    assert.equal(isDefaultNamespaced(doc), true);
  });

test('isDefaultNamespaced: prefixed-only xmlns is no default', () => {
  const doc = { documentElement: el({
    'xmlns:svg': 'http://www.w3.org/2000/svg' }) };
  assert.equal(isDefaultNamespaced(doc), false);
});

test('isDefaultNamespaced: xmlns="" undeclaration is no default',
  () => {
    const doc = { documentElement: el({ xmlns: '' }) };
    assert.equal(isDefaultNamespaced(doc), false);
  });

test('isDefaultNamespaced: no documentElement is false', () => {
  assert.equal(isDefaultNamespaced({ documentElement: null }), false);
  assert.equal(isDefaultNamespaced(null), false);
});

test('isDefaultNamespaced: a user xmlns:_ disables the rewrite',
  () => {
    // the collision rule: the user's own `_` binding wins, so the
    // rewrite stands down for that document
    const doc = { documentElement: el({
      xmlns: 'http://www.w3.org/1999/xhtml',
      'xmlns:_': 'urn:user:_' }) };
    assert.equal(isDefaultNamespaced(doc), false);
  });

test('isDefaultNamespaced: xmlns:_ on an ancestor disables too', () => {
  const ancestor = el({ 'xmlns:_': 'urn:user:_' });
  const doc = { documentElement: Object.assign(
    el({ xmlns: 'http://www.w3.org/1999/xhtml' }),
    { parentNode: ancestor }) };
  assert.equal(isDefaultNamespaced(doc), false);
});