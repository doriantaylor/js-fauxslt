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