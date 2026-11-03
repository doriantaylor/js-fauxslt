// Unit tests for the XSLT 1.0 §5.2 pattern validator. These are pure
// syntax/compile tests, no DOM required, so they run in node:test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePattern, UnsupportedPatternError, NotImplementedError,
} from '../src/pattern.js';

const ok = (expr) => () => {
  const c = compilePattern(expr);
  assert.ok(c.expr === expr);
};

const bad = (expr) => () =>
  assert.throws(() => compilePattern(expr), UnsupportedPatternError);

const notImpl = (expr) => () =>
  assert.throws(() => compilePattern(expr), NotImplementedError);

// --- valid §5.2 patterns -------------------------------------------
test('accepts: bare name', ok('para'));
test('accepts: wildcard', ok('*'));
test('accepts: namespaced name', ok('svg:circle'));
test('accepts: namespace wildcard', ok('svg:*'));
test('accepts: prefixed wildcard', ok('*:para'));
test('accepts: child axis', ok('child::para'));
test('accepts: attribute axis', ok('attribute::name'));
test('accepts: attribute abbreviation', ok('@name'));
test('accepts: descendant-or-self path', ok('//para'));
test('accepts: absolute path', ok('/doc/body/para'));
test('accepts: rooted descendant path', ok('//div/p'));
test('accepts: relative chain', ok('chapter/section/para'));
test('accepts: parent step', ok('../para'));
test('accepts: self step', ok('./para'));
test('accepts: node type tests', ok('text()'));
test('accepts: comment type test', ok('comment()'));
test('accepts: processing-instruction test',
  ok('processing-instruction("xml-stylesheet")'));
test('accepts: plain pi test', ok('processing-instruction()'));
test('accepts: node() test', ok('node()'));
test('accepts: positional predicate', ok('para[1]'));
test('accepts: last() predicate', ok('item[last()]'));
test('accepts: not() attribute predicate',
  ok('main[not(@hidden)]'));
test('contains() class predicate',
  ok('li[contains(@class, "item")]'));
test('accepts: union of patterns', ok('para | heading | sub'));
test('accepts: id pattern', ok("id('intro')"));
test('accepts: id with steps', ok("id('intro')/para"));
test('accepts: predicate with function call',
  ok("item[position() = 2]"));
test('accepts: nested predicates', ok('div[@id][1]'));
test('accepts: arithmetic in predicate',
  ok('item[position() + 1 = 2]'));
test('accepts: attribute step in path', ok('@foo/@bar'));
test('accepts: bare attribute step', ok('@*'));
test('accepts: string equality predicate',
     ok("para[@class = 'draft']"));
test('accepts: arbitrary path axes in predicates', ok('text()[ancestor::pre]'));
// predicates are arbitrary Exprs (§5.2 constrains only the outer
// path), so every XPath 1.0 axis parses in predicate position. the
// six previously-accepted axes (child, attribute, self, parent,
// descendant, descendant-or-self) pin the full-set criterion;
// descendant-or-self:: especially, since // was its only prior
// route in a predicate
test('accepts: ancestor axis in predicate', ok('text()[ancestor::pre]'));
test('accepts: ancestor-or-self axis in predicate',
  ok('li[ancestor-or-self::ul]'));
test('accepts: following-sibling axis in predicate',
  ok('li[following-sibling::*]'));
test('accepts: preceding-sibling axis in predicate',
  ok('li[preceding-sibling::li]'));
test('accepts: following axis in predicate', ok('div[following::p]'));
test('accepts: preceding axis in predicate', ok('item[preceding::li]'));
test('accepts: descendant axis in predicate', ok('li[descendant::ul]'));
test('accepts: descendant-or-self axis in predicate',
  ok('p[descendant-or-self::x]'));
test('accepts: child axis in predicate', ok('d[child::x]'));
test('accepts: attribute axis in predicate', ok('a[attribute::href]'));
test('accepts: self axis in predicate', ok('s[self::s]'));
test('accepts: parent axis in predicate', ok('q[parent::q]'));
test('accepts: namespace axis in predicate', ok('p[namespace::x]'));
test('accepts: nested predicate path with an axis',
  ok('div[div[following::p]]'));

// the serializer (serStep) emits axis:: for any axis; assert the
// round-trip so a serializer regression fails loudly
test('predicated axes round-trip through serialization', () => {
  assert.equal(
    compilePattern('text()[ancestor::pre]').evalExpr,
    'text()[ancestor::pre]');
  // the prefix rewrite reaches predicate steps
  assert.equal(
    compilePattern('text()[ancestor::pre]', { prefix: '_' }).evalExpr,
    'text()[ancestor::_:pre]');
  // namespace-axis name tests are never rewritten: namespace nodes
  // are not element name tests (see rewriteNameTests)
  assert.equal(
    compilePattern('p[namespace::x]', { prefix: '_' }).evalExpr,
    '_:p[namespace::x]');
  assert.equal(
    compilePattern('p[namespace::x]').evalExpr,
    'p[namespace::x]');
});

// --- outside the subset: syntax errors ------------------------------
test('rejects: empty', bad(''));
test('rejects: variable reference', bad('$x'));
test('rejects: unknown function in predicate', bad('li[frob()]'));
test('rejects: key() inside predicate', bad("li[key('k', 'v')]"));
test('rejects: unsupported axis', bad('ancestor::para'));
test('rejects: following-sibling axis', bad('following-sibling::*'));
// the §5.2 child/attribute constraint binds the OUTER path only;
// a forbidden outer axis is rejected even with a legal predicate
test('rejects: unsupported outer axis with legal predicate',
  bad('ancestor::para[x]'));
test('rejects: text node with argument', bad('text("x")'));
test('rejects: numeric-only', bad('42'));
test('rejects: malformed predicate', bad('li['));
test('rejects: unbalanced literal', bad("li[@class = 'x]"));

// --- key(): parses, not implemented ---------------------------------
test('key() top-level throws not-implemented', notImpl("key('k', 'v')"));
test('key() with steps throws not-implemented',
  notImpl("key('items', 'x')//li"));
test('id()/key() metadata absolute', () => {
  const c = compilePattern("id('intro')");
  assert.equal(c.absolute, true);
  const c2 = compilePattern('para');
  assert.equal(c2.absolute, false);
});

// --- name-test rewrite ----------------------------------------------
// unprefixed element name tests are rewritten ONLY when an explicit
// prefix is given (the synthetic `_` when the document has a default
// namespace); the default is NO rewrite, so unprefixed names keep
// their native XPath 1.0 semantics (matching namespace-less
// elements) in HTML and no-namespace XML documents
test('rewrites unprefixed names to the explicit prefix', () => {
  assert.equal(compilePattern('para', { prefix: '_' }).evalExpr,
    '_:para');
  assert.equal(
    compilePattern('chapter/section/para', { prefix: '_' }).evalExpr,
    '_:chapter/_:section/_:para');
  assert.equal(compilePattern('//div/p', { prefix: '_' }).evalExpr,
    '//_:div/_:p');
  assert.equal(
    compilePattern("id('intro')/para", { prefix: '_' }).evalExpr,
    "id('intro')/_:para");
  assert.equal(
    compilePattern('para | heading', { prefix: '_' }).evalExpr,
    '_:para | _:heading');
});

test('no prefix by default: patterns pass through unrewritten', () => {
  assert.equal(compilePattern('para').evalExpr, 'para');
  assert.equal(compilePattern('chapter/section/para').evalExpr,
    'chapter/section/para');
  assert.equal(compilePattern('//div/p').evalExpr, '//div/p');
  assert.equal(compilePattern("id('intro')/para").evalExpr,
    "id('intro')/para");
  assert.equal(compilePattern('para | heading').evalExpr,
    'para | heading');
});

test('leaves already-prefixed names alone', () => {
  assert.equal(compilePattern('svg:circle').evalExpr, 'svg:circle');
  assert.equal(compilePattern('svg:*').evalExpr, 'svg:*');
  assert.equal(
    compilePattern('svg:circle', { prefix: '_' }).evalExpr,
    'svg:circle');
  assert.equal(compilePattern('svg:*', { prefix: '_' }).evalExpr,
    'svg:*');
});

test('leaves attribute names and wildcards alone', () => {
  assert.equal(compilePattern('@name').evalExpr, '@name');
  assert.equal(compilePattern('*').evalExpr, '*');
  assert.equal(compilePattern('*', { prefix: '_' }).evalExpr, '*');
  assert.equal(compilePattern('@name', { prefix: '_' }).evalExpr,
    '@name');
  assert.equal(compilePattern(
    'li[contains(@class, "hidden")]', { prefix: '_' }).evalExpr,
    "_:li[contains(@class, 'hidden')]");
});
// --- §5.5 default priorities ---------------------------------------
const prio = (expr, expected) => () => {
  const c = compilePattern(expr);
  assert.equal(c.branches.length, 1);
  assert.equal(c.branches[0].priority, expected);
};

test('priority: bare name is 0', prio('para', 0));
test('priority: namespaced name is 0', prio('svg:circle', 0));
test('priority: wildcard is -0.5', prio('*', -0.5));
test('priority: namespace wildcard svg:* is -0.25', prio('svg:*', -0.25));
test('priority: any-namespace wildcard *:para is -0.25', prio('*:para', -0.25));
test('priority: predicate bumps to 0.5', prio('para[@class]', 0.5));
test('priority: node() is -0.5', prio('node()', -0.5));
test('priority: text() is -0.5', prio('text()', -0.5));
test('priority: comment() is -0.5', prio('comment()', -0.5));
test('priority: processing-instruction() is -0.5 per §5.5',
  prio('processing-instruction()', -0.5));
test('priority: named processing-instruction is 0 per §5.5',
  prio("processing-instruction('x')", 0));
test('priority: last step governs in multi-step', prio('chapter/para', 0));

// --- union branch splitting -----------------------------------------
test('unions split into elementary branches with priorities', () => {
  const c = compilePattern('para | * | svg:circle',
    { prefix: '_' });
  assert.equal(c.branches.length, 3);
  assert.equal(c.branches[0].priority, 0);
  assert.equal(c.branches[1].priority, -0.5);
  assert.equal(c.branches[2].priority, 0);
  // each branch serializes to its own single-step expression
  assert.equal(c.branches[0].expr, '_:para');
});

// --- multi-step rewrite to default (child) axis ---------------------
test('rewrite: a/b becomes b[parent::a]', () => {
  const c = compilePattern('a/b', { prefix: '_' });
  assert.equal(c.branches[0].evalExpr, '_:b[parent::_:a]');
});

test('rewrite: a/b//c becomes c[ancestor-or-self::b/parent::a]', () => {
  const c = compilePattern('a/b//c', { prefix: '_' });
  assert.equal(
    c.branches[0].evalExpr,
    '_:c[ancestor-or-self::_:b/parent::_:a]');
});

test('rewrite: single-step patterns pass through', () => {
  const c = compilePattern('para', { prefix: '_' });
  assert.equal(c.branches[0].evalExpr, '_:para');
});

test('rewrite: predicates on the last step are preserved', () => {
  const c = compilePattern('a/b[@class="x"]', { prefix: '_' });
  // the ancestry predicate is APPENDED: the step's own predicates
  // keep their natural (§5.5) order, which positional predicates
  // require
  assert.equal(c.branches[0].evalExpr,
    "_:b[@class='x'][parent::_:a]");
});

test('rewrite: absolute patterns are not rewritten', () => {
  const c = compilePattern('/doc/para', { prefix: '_' });
  assert.ok(c.branches[0].absolute);
  // no ancestry predicate; only the prefix rewrite applies
  assert.equal(c.branches[0].evalExpr, '/_:doc/_:para');
});

test('rewrite: single-step patterns with predicates keep their order', () => {
  // no ancestry rewrite for single-step branches; only the prefix
  // applies
  const c = compilePattern('li[@class="x"][2]', { prefix: '_' });
  assert.equal(c.branches[0].evalExpr,
    "_:li[@class='x'][2]");
});

// without a prefix the multi-step rewrite still applies, but the
// name tests stay unprefixed (native matching)
test('rewrite: ancestry predicates work without a prefix too', () => {
  const c = compilePattern('a/b');
  assert.equal(c.branches[0].evalExpr, 'b[parent::a]');
});

// --- root pattern ---------------------------------------------------
test('compilePattern: / parses as the root pattern', () => {
  const c = compilePattern('/');
  assert.equal(c.expr, '/');
  assert.equal(c.branches.length, 1);
  // the root pattern is absolute and netted only from the root
  assert.equal(c.branches[0].absolute, true);
  assert.equal(c.absolute, true);
  assert.equal(c.branches[0].evalExpr, '/');
  // §5.5's final clause: a pattern that isn't just a NodeTest
  // carries priority +0.5. the built-in / outranks every user
  // pattern that nets a document node except an explicit priority
  // or a tie-won re-registration
  assert.equal(c.branches[0].priority, 0.5);
});

// --- on-demand matching classification --------------------------------
// each elementary branch carries the class of the single context its
// membership check runs from (see pattern.js's classifyBranch). the
// classification is pure compile-time logic over the REWRITTEN AST
const match = (expr, expected, opts) => () => {
  const c = compilePattern(expr, opts);
  assert.equal(c.branches.length, 1);
  assert.equal(c.branches[0].match, expected);
};

test('classifies: bare name → parent', match('foo', 'parent'));
test('classifies: rewritten multi-step → parent',
  match('a/b', 'parent'));
test('classifies: deep multi-step → parent', match('a/b//c', 'parent'));
test('classifies: node type test → parent', match('text()', 'parent'));
test('classifies: predicated name → parent', match('a[1]', 'parent'));
test('classifies: leading ./ step → parent (rewritten)',
  match('./foo', 'parent'));
test('classifies: leading ../ step → parent (rewritten)',
  match('../foo', 'parent'));
test('classifies: attribute → owner', match('@x', 'owner'));
test('classifies: rewritten attribute tail → owner',
  match('a/@x', 'owner'));
test('classifies: bare . → self', match('.', 'self'));
test('classifies: bare .. → scan', match('..', 'scan'));
test('classifies: parent-tailed multi-step → scan',
  match('a/..', 'scan'));
test('classifies: self-tailed multi-step → scan',
  match('a/.', 'scan'));
test('classifies: absolute path → root', match('//x', 'root'));
test('classifies: rooted path → root', match('/doc/x', 'root'));
test('classifies: bare root → root', match('/', 'root'));
test('classifies: id() → root', match("id('x')", 'root'));

test('classifies each union branch independently', () => {
  const c = compilePattern('foo | @x | . | ..');
  assert.deepEqual(c.branches.map(b => b.match),
    ['parent', 'owner', 'self', 'scan']);
});
