// Pattern front-end for fauxslt: validate XSLT 1.0 §5.2 patterns,
// extract match metadata, and delegate evaluation to the native
// DOM XPathEvaluator (document.evaluate).
//
// The peggy grammar accepts exactly the §5.2 pattern production set
// and a restricted predicate-expression subset (see the grammar
// header). Validation fails loudly at registration time. Evaluation
// always uses the ORIGINAL expression string through the browser's
// XPath 1.0 engine, so there is no fidelity gap between what was
// validated and what runs.

import { parse } from './xpath-pattern.js';

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

// compile a pattern: validate syntax, reject key(), return metadata
export function compilePattern (expr) {
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

  return {
    expr,
    ast,
    // an absolute pattern (/ or // rooted) matches by evaluating from
    // the document root; a relative pattern is tested per-node
    absolute: isAbsolute(ast),
  };
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

function isAbsolute (ast) {
  // union patterns are per-branch
  if (ast && ast.type === 'union')
    return ast.branches.every(b => isAbsolute(b));
  if (ast && ast.type === 'path') return ast.from === 'root';
  // id()/key() patterns are inherently absolute per §5.2
  return true;
}

// evaluate a compiled pattern as a boolean match test against one
// node, using the native XPathEvaluator. per §5.2, a pattern matches
// a node iff evaluating it as an expression with that node as context
// produces a node-set containing the node.
export function matchesNode (compiled, node) {
  const ownerDoc = node.ownerDocument || node;
  const result = ownerDoc.evaluate(
    compiled.expr, node, null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  for (let i = 0; i < result.snapshotLength; i++)
    if (result.snapshotItem(i) === node) return true;
  return false;
}

// evaluate a compiled pattern as a node-set snapshot (for select())
export function selectNodes (compiled, node) {
  const ownerDoc = node.ownerDocument || node;
  const result = ownerDoc.evaluate(
    compiled.expr, node, null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const out = [];
  for (let i = 0; i < result.snapshotLength; i++)
    out.push(result.snapshotItem(i));
  return out;
}

// general expression evaluation for select(): may return nodes,
// a number, a string, or a boolean, depending on the expression
export function evaluateExpr (expr, node) {
  const ownerDoc = node.ownerDocument || node;
  const result = ownerDoc.evaluate(
    expr, node, null, XPathResult.ANY_TYPE, null);
  switch (result.resultType) {
    case XPathResult.NUMBER_TYPE:
      return result.numberValue;
    case XPathResult.STRING_TYPE:
      return result.stringValue;
    case XPathResult.BOOLEAN_TYPE:
      return result.booleanValue;
    default: {
      // ANY_TYPE from a node-set expression: iterate
      const out = [];
      let n;
      while ((n = result.iterateNext())) out.push(n);
      return out;
    }
  }
}