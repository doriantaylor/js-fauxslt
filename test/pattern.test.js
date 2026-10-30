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

// --- outside the subset: syntax errors ------------------------------
test('rejects: empty', bad(''));
test('rejects: variable reference', bad('$x'));
test('rejects: unknown function in predicate', bad('li[frob()]'));
test('rejects: key() inside predicate', bad("li[key('k', 'v')]"));
test('rejects: unsupported axis', bad('ancestor::para'));
test('rejects: following-sibling axis', bad('following-sibling::*'));
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

// --- xhtml prefix rewrite -------------------------------------------
// unprefixed element name tests are rewritten to the synthetic xhtml
// prefix at compile time (XPath 1.0 has no default namespace), so
// one pattern matches both HTML and XHTML documents
test('rewrites unprefixed names to the xhtml prefix', () => {
  assert.equal(compilePattern('para').evalExpr, 'html:para');
  assert.equal(compilePattern('chapter/section/para').evalExpr,
    'html:chapter/html:section/html:para');
  assert.equal(compilePattern('//div/p').evalExpr, '//html:div/html:p');
  assert.equal(compilePattern("id('intro')/para").evalExpr,
    "id('intro')/html:para");
  assert.equal(compilePattern('para | heading').evalExpr,
    'html:para | html:heading');
});

test('leaves already-prefixed names alone', () => {
  assert.equal(compilePattern('svg:circle').evalExpr, 'svg:circle');
  assert.equal(compilePattern('svg:*').evalExpr, 'svg:*');
});

test('leaves attribute names and wildcards alone', () => {
  assert.equal(compilePattern('@name').evalExpr, '@name');
  assert.equal(compilePattern('*').evalExpr, '*');
  assert.equal(compilePattern('li[contains(@class, "hidden")]').evalExpr,
    "html:li[contains(@class, 'hidden')]");
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
  const c = compilePattern('para | * | svg:circle');
  assert.equal(c.branches.length, 3);
  assert.equal(c.branches[0].priority, 0);
  assert.equal(c.branches[1].priority, -0.5);
  assert.equal(c.branches[2].priority, 0);
  // each branch serializes to its own single-step expression
  assert.equal(c.branches[0].expr, 'html:para');
});

// --- multi-step rewrite to default (child) axis ---------------------
test('rewrite: a/b becomes b[parent::a]', () => {
  const c = compilePattern('a/b');
  assert.equal(c.branches[0].evalExpr, 'html:b[parent::html:a]');
});

test('rewrite: a/b//c becomes c[ancestor-or-self::b/parent::a]', () => {
  const c = compilePattern('a/b//c');
  assert.equal(
    c.branches[0].evalExpr,
    'html:c[ancestor-or-self::html:b/parent::html:a]');
});

test('rewrite: single-step patterns pass through', () => {
  const c = compilePattern('para');
  assert.equal(c.branches[0].evalExpr, 'html:para');
});

test('rewrite: predicates on the last step are preserved', () => {
  const c = compilePattern('a/b[@class="x"]');
  // the ancestry predicate is APPENDED: the step's own predicates
  // keep their natural (§5.5) order, which positional predicates
  // require
  assert.equal(c.branches[0].evalExpr,
    "html:b[@class='x'][parent::html:a]");
});

test('rewrite: absolute patterns are not rewritten', () => {
  const c = compilePattern('/doc/para');
  assert.ok(c.branches[0].absolute);
  // no ancestry predicate; only the xhtml prefix rewrite applies
  assert.equal(c.branches[0].evalExpr, '/html:doc/html:para');
});

test('rewrite: single-step patterns with predicates keep their order', () => {
  // no rewrite for single-step branches; the xhtml prefix applies
  const c = compilePattern('li[@class="x"][2]');
  assert.equal(c.branches[0].evalExpr,
    "html:li[@class='x'][2]");
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
