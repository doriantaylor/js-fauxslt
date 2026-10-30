// Unit tests for the Template metadata class: getters, priority
// override, and registry identity. Pure JS, no DOM, so node:test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Template } from '../src/template.js';

test('Template compiles a match pattern into branches', () => {
  const t = new Template({ match: 'para | svg:circle', fn: () => null });
  assert.equal(t.kind, 'match');
  assert.equal(t.pattern, 'para | svg:circle');
  assert.equal(t.patterns.length, 2);
  assert.equal(t.expressions.length, 2);
  // no prefix option: patterns pass through unrewritten (the new
  // default)
  assert.equal(t.computedPattern, 'para | svg:circle');
});

test('Template threads the prefix option into compilePattern', () => {
  const t = new Template({ match: 'para | svg:circle',
    fn: () => null, prefix: '_' });
  assert.equal(t.computedPattern, '_:para | svg:circle');
  const bare = new Template({ match: 'para', fn: () => null,
    prefix: '_' });
  assert.equal(bare.computedPattern, '_:para');
});

test('Template getters are null for named-only templates', () => {
  const t = new Template({ name: 'shim', fn: () => null });
  assert.equal(t.kind, 'named');
  assert.equal(t.pattern, null);
  assert.equal(t.patterns, null);
  assert.equal(t.expressions, null);
  assert.equal(t.computedPattern, null);
  assert.equal(t.getPriority(), null);
});

test('getPriority returns the §5.5 computed default', () => {
  const t = new Template({ match: 'para', fn: () => null });
  assert.equal(t.getPriority(), 0);
  const w = new Template({ match: '*', fn: () => null });
  assert.equal(w.getPriority(), -0.5);
});

test('explicit priority overrides the computed default', () => {
  const t = new Template({ match: 'para', fn: () => null, priority: 3 });
  assert.equal(t.getPriority(), 3);
});

test('getPriority accepts a branch expression', () => {
  const t = new Template({ match: 'para | *', fn: () => null });
  assert.equal(t.getPriority('para'), 0);
  assert.equal(t.getPriority('*'), -0.5);
  // no argument: best (highest) across the union
  assert.equal(t.getPriority(), 0);
});

test('a template can carry both a pattern and a name', () => {
  const t = new Template({ match: 'para', name: 'shim', fn: () => null });
  assert.equal(t.kind, 'match+named');
  assert.equal(t.key, 'shim');
});

test('a template requires a pattern, a name, or both', () => {
  assert.throws(() => new Template({ fn: () => null }), Error);
  assert.throws(() => new Template({ match: 'para' }), TypeError);
});
