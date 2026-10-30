// Pattern front-end for fauxslt: validate XSLT 1.0 §5.2 patterns,
// extract match metadata, and delegate evaluation to the native
// XPathEvaluator (XPathEvaluator.createExpression — the expression
// is compiled once per document and evaluated repeatedly).
//
// The peggy grammar accepts exactly the §5.2 pattern production set
// and a restricted predicate-expression subset (see the grammar
// header). Validation fails loudly at registration time. Evaluation
// always uses the ORIGINAL expression string through the browser's
// XPath 1.0 engine, so there is no fidelity gap between what was
// validated and what runs.

import { parse } from './xpath-pattern.js';

// synthetic prefix bound to the XHTML namespace at evaluation time.
// unprefixed element name tests are rewritten to this prefix so that
// one expression matches both HTML documents (whose elements the DOM
// reports as namespace-less but which match XHTML-mapped prefixed
// names in XPathEvaluator results) and XHTML documents (where unprefixed
// XPath names match no namespace at all). the empty prefix has no
// default namespace in XPath 1.0, so this is the only uniform route.
export const XHTML_PREFIX = 'html';

export class UnsupportedPatternError extends Error {
  constructor (message) {
    super(message);
    this.name = 'UnsupportedPatternError';
  }
}

export class NotImplementedError extends Error {
  constructor (message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

function isAbsolute (ast) {
  // union patterns are per-branch
  if (ast && ast.type === 'union')
    return ast.branches.every(b => isAbsolute(b));
  if (ast && ast.type === 'path') return ast.from === 'root';
  // id()/key() patterns are inherently absolute per §5.2
  return true;
}

// rewrite a relative multi-step pattern branch into single-step form
// with an ancestry predicate: a/b//c becomes
//   c[ancestor-or-self::b/parent::a]
// i.e. the last step stands alone and the inverse of the preceding
// path becomes a predicate, so the pattern can be tested against any
// node in one boolean evaluation during the preemptive scan.
function rewriteBranch (branch) {
  if (branch.type !== 'path' || branch.from !== 'context')
    return branch;
  const steps = branch.steps || [];
  if (steps.length <= 1) return branch;

  // walk the preceding steps, building the inverse path predicate
  const last = steps[steps.length - 1];
  // self/parent steps in the tail complicate inversion; keep them
  // verbatim until a use case demands more
  if (last.type === 'self' || last.type === 'parent') return branch;

  // build the inverse: for each preceding step (rightmost first) the
  // axis is governed by the separator BETWEEN it and its successor:
  // a step followed by a deep step (//) inverts to ancestor-or-self,
  // otherwise parent. the deep marker lives on the FOLLOWING step.
  const inverseSteps = [];
  for (let i = steps.length - 2; i >= 0; i--) {
    const s = steps[i];
    if (s.type === 'self') { inverseSteps.push(s); continue; }
    if (s.type === 'parent') { inverseSteps.push(s); continue; }
    const next = steps[i + 1];
    const axis = next && next.deep ? 'ancestor-or-self' : 'parent';
    inverseSteps.push({
      type: 'step', axis, test: s.test,
      predicates: s.predicates || [],
    });
  }

  // ancestor-or-self inverts the immediately preceding deep chain:
  // for b//c the inverse is ancestor-or-self::b — rightmost-first
  const pred = {
    type: 'path', from: 'context', steps: inverseSteps,
  };
  const rewritten = {
    type: 'path', from: 'context',
    steps: [{
      type: 'step', axis: last.axis, test: last.test,
      predicates: (last.predicates || []).concat([pred]),
    }],
  };
  return rewritten;
}

// render a rewritten single-step relative branch as a self-anchored
// boolean test expression: para becomes self::html:para, and
// b[parent::a] becomes self::html:b[parent::a]. evaluating this with
// a candidate node as context, in boolean mode, decides whether the
// node matches the branch — the form the preemptive scan in
// Transform wants. branches whose subject step is an attribute,
// self, or parent step (and multi-step branches that were not
// rewritten) have no such form and yield null; the scan falls back
// to per-context node-set evaluation for those.
function selfAnchor (branch) {
  if (!branch || branch.type !== 'path' ||
    branch.from !== 'context')
    return null;
  const steps = branch.steps || [];
  if (steps.length !== 1) return null;
  const s = steps[0];
  if (s.type !== 'step' || s.axis === 'attribute') return null;
  return serStep(Object.assign({}, s, { axis: 'self' }));
}

// compile a pattern: validate syntax, reject key(), rewrite unprefixed
// element name tests to the XHTML prefix, split unions, compute §5.5
// priorities, and rewrite relative multi-step branches to single-step
// form. returns metadata including per-branch { expr, priority,
// evalExpr, absolute } entries.
export function compilePattern (expr, opts = {}) {
  let ast = null;
  try {
    ast = parse(expr, { grammarSource: expr });
  }
  catch (e) {
    throw new UnsupportedPatternError(
      'invalid XSLT pattern: ' + expr + ': ' + e.message);
  }

  // key() parses per §5.2 but there is no key support (yet)
  if (findKeyNode(ast))
    throw new NotImplementedError(
      'key() is not implemented: ' + expr);

  const prefix = opts.xhtmlPrefix !== undefined ?
    opts.xhtmlPrefix : XHTML_PREFIX;

  // rewrite unprefixed element name tests to the xhtml prefix so the
  // expression matches uniformly in HTML and XHTML. attribute names
  // are left alone: in the HTML DOM attributes are namespace-less,
  // and unprefixed attribute tests match exactly that.
  rewriteNameTests(ast, prefix);

  // split unions into elementary branches, compute §5.5 priorities,
  // and rewrite multi-step relative branches into predicate form
  const branches = (ast.type === 'union' ?
    ast.branches : [ast]).map(b => {
    // priority is computed on the ORIGINAL branch, per §5.5: the
    // last step's own test and predicates — the ancestry predicate
    // introduced by the rewrite must not inflate it
    const priority = computePriority(b);
    const rewritten = rewriteBranch(b);
    return {
      expr: serializePattern(rewritten),
      evalExpr: serializePattern(rewritten),
      boolExpr: selfAnchor(rewritten),
      priority,
      absolute: isAbsolute(b),
      ast: rewritten,
    };
  });

  return {
    expr,
    ast,
    branches,
    absolute: branches.every(b => b.absolute),
    // the expression actually handed to XPathEvaluator (whole
    // pattern, for the legacy evaluation path)
    evalExpr: reserialize(ast, expr),
  };
}

// walk the AST and prefix unprefixed element name tests
function rewriteNameTests (node, prefix) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'step' && node.test && node.test.kind === 'name') {
    const name = node.test.name;
    // element steps only; attribute steps carry axis 'attribute'
    if (node.axis !== 'attribute' &&
      name.indexOf(':') === -1 && name !== '*')
      node.test.name = prefix + ':' + name;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) for (const n of v) rewriteNameTests(n, prefix);
    else if (v && typeof v === 'object') rewriteNameTests(v, prefix);
  }
}

// produce the evaluation expression from the (rewritten) AST
function reserialize (ast, original) {
  try {
    return serializePattern(ast);
  }
  catch (e) {
    // if serialization ever fails, fall back to the original —
    // validation already passed
    return original;
  }
}

function findKeyNode (node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'key') return true;
  for (const k of Object.keys(node)) {
    if (Array.isArray(node[k])) {
      for (const n of node[k]) if (findKeyNode(n)) return true;
    }
    else if (node[k] && typeof node[k] === 'object')
      if (findKeyNode(node[k])) return true;
  }
  return false;
}

// compute the default priority of an elementary (non-union) pattern
// per XSLT 1.0 §5.5: the priority falls out of the LAST step's node
// test and predicate count. explicit `priority` overrides this at
// the Template level (getPriority), not here.
function computePriority (branch) {
  if (!branch) return 0;
  // id()/key() carry an implicit +0.5 in most engines' practice;
  // §5.5 is silent, so we treat them like any other pattern
  if (branch.type === 'id' || branch.type === 'key')
    return 0.5;
  if (branch.type !== 'path') return 0;
  const steps = branch.steps || [];
  if (!steps.length) return 0;
  const last = steps[steps.length - 1];
  if (last.type === 'self' || last.type === 'parent')
    return 0.5; // treated as node() wildcard-ish; §5.5 silent — we
  // deliberately treat . and .. like a wildcard step
  const t = last.test;
  if (!t) return 0.5;
  if (last.predicates && last.predicates.length)
    return 0.5;
  if (t.kind === 'type') {
    if (t.name === 'processing-instruction') return -0.25;
    // text(), comment(), node()
    return -0.5;
  }
  if (t.kind === 'name') {
    if (t.name === '*') return -0.5;
    // namespace wildcard (svg:*) or any-namespace wildcard (*:para):
    // both are partial wildcards, §5.5-analogous to -0.25
    if (t.name.slice(-2) === ':*' || t.name.slice(0, 2) === '*:')
      return -0.25;
    return 0;
  }
  return 0.5;
}

// split a pattern AST into its elementary branches: unions are split
// out; non-union patterns are singletons. each branch keeps its own
// (eventually rewritten) evaluation expression and priority.
export function elementaryBranches (ast) {
  if (ast.type === 'union')
    return ast.branches.map(b => ({ branch: b }));
  return [{ branch: ast }];
}

// serialize a pattern AST back to an XPath expression string. the
// node shapes come from the grammar; this is the inverse of parse()
// for the subset fauxslt supports, used to emit the rewritten
// (xhtml-prefixed) evaluation expression.
export function serializePattern (ast) {
  return serPattern(ast);
}

function serPattern (n) {
  if (n.type === 'union')
    return n.branches.map(serLocationPath).join(' | ');
  return serLocationPath(n);
}

function serLocationPath (n) {
  if (n.type === 'id') return "id('" + n.id + "')" +
    (n.steps ? '/' + serSteps(n.steps) : '');
  if (n.type === 'key') return "key('" + n.name + "','" + n.value + "')" +
    (n.steps ? '/' + serSteps(n.steps) : '');
  // path
  if (n.from === 'root') {
    // a deep-rooted pattern (//…) carries deep on its first step;
    // emit the // there rather than a redundant root slash
    if (n.steps.length && n.steps[0].deep) return serSteps(n.steps);
    return '/' + serSteps(n.steps);
  }
  return serSteps(n.steps);
}

function serSteps (steps, descOrSelf) {
  const parts = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.deep) parts.push('//');
    else if (i > 0) parts.push('/');
    parts.push(serStep(s));
  }
  return parts.join('');
}

function serStep (s) {
  if (s.type === 'self') return '.';
  if (s.type === 'parent') return '..';
  let out = '';
  if (s.axis === 'attribute') out += '@';
  else if (s.axis && s.axis !== 'child') out += s.axis + '::';
  out += serTest(s.test);
  for (const p of s.predicates || []) out += '[' + serExpr(p) + ']';
  return out;
}

function serTest (t) {
  if (t.kind === 'name') return t.name;
  if (t.name === 'processing-instruction')
    return 'processing-instruction(' +
      (t.literal ? "'" + t.literal + "'" : '') + ')';
  return t.name + '()';
}

function serExpr (e) {
  switch (e.type) {
    case 'num': return String(e.value);
    case 'str': return "'" + e.value + "'";
    case 'or': case 'and':
      return serExpr(e.left) + ' ' + e.type + ' ' + serExpr(e.right);
    case 'eq': return serExpr(e.left) + '=' + serExpr(e.right);
    case 'ne': return serExpr(e.left) + '!=' + serExpr(e.right);
    case 'lt': case 'le': case 'gt': case 'ge':
    case 'add': case 'sub': case 'mul': case 'div': case 'mod':
      return serExpr(e.left) + ' ' +
        (e.type === 'add' ? '+' : e.type === 'sub' ? '-' :
          e.type === 'mul' ? '*' : e.type) + ' ' + serExpr(e.right);
    case 'neg': return '-' + serExpr(e.operand);
    case 'call':
      return e.name + '(' + (e.args || []).map(serExpr).join(', ') + ')';
    case 'path': return serLocationPath(e);
    case 'filterPath':
      return serExpr(e.base) + '/' + serSteps(e.steps);
    case 'filter':
      return serExpr(e.base) +
        (e.predicates || []).map(p => '[' + serExpr(p) + ']').join('');
    case 'unionExpr':
      return serExpr(e.left) + ' | ' + serExpr(e.right);
    default:
      throw new Error('cannot serialize expression node: ' + e.type);
  }
}