// Grammar for XSLT 1.0 patterns, per W3C REC XSLT 1.0 (1999-11-16),
// section 5.2 "Patterns". A pattern is NOT a general XPath
// expression: only the §5.2 production set is accepted, and anything
// else fails loudly at registration time.
//
//   Pattern             ::= LocationPathPattern ('|' LocationPathPattern)*
//   LocationPathPattern ::= '/' RelativePathPattern?
//                          | IdKeyPattern (('/' | '//') RelativePathPattern)?
//                          | '//'? RelativePathPattern
//   RelativePathPattern ::= StepPattern (('/' | '//') StepPattern)*
//   StepPattern         ::= (ChildOrAttributeAxisName '::')? NodeTest
//                          Predicate* | '.' | '..'
//   NodeTest           ::= NameTest | NodeType '(' ')'
//   IdKeyPattern       ::= 'id(' LITERAL ')'
//                          | 'key(' LITERAL ',' LITERAL ')'
//
// PredicateExpr is parsed with a restricted XPath 1.0 expression
// grammar: no variable references (XSLT forbids them in patterns),
// only core-library function calls, and only the child, attribute,
// self, parent, descendant, and descendant-or-self axes. Those are
// documented deviations from "any Expr" — the practical subset.
//
// key() is part of the §5.2 grammar so it PARSES (top level only,
// never inside predicates); evaluation throws not-implemented.
//
// AST shape (JSON-friendly, evaluator-agnostic):
//   { type: 'union', branches: [LocationPathPattern, ...] }
//   { type: 'path', from: 'root' | 'context', steps: [Step, ...] }
//   { type: 'id', id: 'literal', steps?: [Step, ...] }
//   { type: 'key', name: 'l', value: 'l', steps?: [Step, ...] }
// Step:
//   { type: 'step', axis: 'child'|'attribute'|..., test: NodeTest,
//     predicates: [Expr, ...], deep?: true }   // deep = preceded by //
//   { type: 'self' } | { type: 'parent' }
// NodeTest:
//   { kind: 'name', name: '*' | 'foo' | 'foo:*' | 'foo:bar' }
//   { kind: 'type', name: 'comment'|'text'|'node'|
//     'processing-instruction', literal: 'x'|null }
// Expr nodes: num, str, or, and, eq, ne, lt, le, gt, ge, add, sub,
// mul, div, mod, neg, call, path, filter, filterPath, unionExpr.

Pattern "pattern"
  = _ first:LocationPathPattern
    rest:(_ "|" _ l:LocationPathPattern { return l; })*
    _ {
      const branches = [first].concat(rest);
      return branches.length === 1 ? first : { type: 'union', branches };
    }

LocationPathPattern
  // IdKeyPattern must be tried BEFORE RelativePathPattern: 'key' is
  // also a valid NCName, so a RelativePathPattern would otherwise
  // match the function name and then choke on the parenthesis
  = ik:IdKeyPattern
    suffix:(_ sep:("//" / "/") _ rel:RelativePathPattern {
      return [sep, rel.steps]; })? {
      if (!suffix) return ik;
      const steps = suffix[1];
      if (suffix[0] === '//') steps[0].deep = true;
      return Object.assign({}, ik, { steps: steps });
    }
  / "//" _ rel:RelativePathPattern {
      rel.steps[0].deep = true;
      return { type: 'path', from: 'root', steps: rel.steps };
    }
  / "/" _ rel:RelativePathPattern? {
      return { type: 'path', from: 'root', steps: rel ? rel.steps : [] };
    }
  / rel:RelativePathPattern {
      return { type: 'path', from: 'context', steps: rel.steps };
    }

IdKeyPattern
  = "id" _ "(" _ s:LITERAL _ ")" {
      return { type: 'id', id: s };
    }
  / "key" _ "(" _ n:LITERAL _ "," _ v:LITERAL _ ")" {
      // parses per §5.2; evaluation throws not-implemented
      return { type: 'key', name: n, value: v };
    }

RelativePathPattern
  = first:StepPattern
    // NB: "//" must be tried before "/": PEG choice is possessive,
    // so with "/" first a/b//c would strand the second slash
    rest:(_ sep:("//" / "/") _ s:StepPattern { return [sep, s]; })* {
      const steps = [first];
      for (const pair of rest) {
        const step = pair[1];
        if (pair[0] === '//') step.deep = true;
        steps.push(step);
      }
      return { type: 'path', from: 'context', steps };
    }

StepPattern
  = ".." { return { type: 'parent' }; }
  / "." { return { type: 'self' }; }
  / axis:ChildOrAttributeAxisSpecifier test:NodeTest
    preds:Predicate* {
      return { type: 'step', axis, test, predicates: preds };
    }

// §5.2 allows only child and attribute axes in pattern steps
ChildOrAttributeAxisSpecifier
  = name:$('child' / 'attribute') "::" { return name; }
  / "@" { return 'attribute'; }
  / "" { return 'child'; }

NodeTest
  = NodeTypeCall
  / NameTest

NodeTypeCall
  = "processing-instruction" _ "(" _ lit:LITERAL? _ ")" {
      return { kind: 'type', name: 'processing-instruction',
        literal: lit || null };
    }
  / t:NodeType _ "(" _ ")" {
      return { kind: 'type', name: t, literal: null };
    }

NodeType
  = "processing-instruction" { return 'processing-instruction'; }
  / "comment" { return 'comment'; }
  / "text" { return 'text'; }
  / "node" { return 'node'; }

NameTest
  = "*" ":" l:NCName {
      // any-namespace wildcard: *:para
      return { kind: 'name', name: '*:' + l };
    }
  / p:NCName ":" "*" { return { kind: 'name', name: p + ':*' }; }
  / q:QName { return { kind: 'name', name: q }; }
  / "*" { return { kind: 'name', name: '*' }; }

QName
  = p:NCName ":" l:NCName { return p + ':' + l; }
  / NCName

// XML NCName, approximated with unicode letter/number classes
NCName "name"
  = first:NCNameStart rest:NCNameChar* {
      return first + rest.join('');
    }

NCNameStart
  = [\p{L}_]

NCNameChar
  = [\p{L}\p{N}_.-]

Predicate "predicate"
  = "[" _ e:Expr _ "]" { return e; }

// restricted XPath 1.0 expression grammar (see header)
Expr "expression"
  = OrExpr

OrExpr
  = left:AndExpr rest:(_ OrKw _ r:AndExpr { return r; })* {
      return rest.reduce(
        (l, r) => ({ type: 'or', left: l, right: r }), left);
    }

AndExpr
  = left:EqualityExpr rest:(_ AndKw _ r:EqualityExpr { return r; })* {
      return rest.reduce(
        (l, r) => ({ type: 'and', left: l, right: r }), left);
    }

EqualityExpr
  = left:RelationalExpr
    rest:(_ op:("=" / "!=") _ r:RelationalExpr { return [op, r]; })* {
      return rest.reduce(
        (l, p) => ({ type: p[0] === '=' ? 'eq' : 'ne',
          left: l, right: p[1] }), left);
    }

RelationalExpr
  = left:AdditiveExpr
    rest:(_ op:("<=" / ">=" / "<" / ">") _ r:AdditiveExpr {
      return [op, r]; })* {
      return rest.reduce(
        (l, p) => ({ type: p[0], left: l, right: p[1] }), left);
    }

AdditiveExpr
  = left:MultiplicativeExpr
    rest:(_ op:("+" / "-") _ r:MultiplicativeExpr { return [op, r]; })* {
      return rest.reduce(
        (l, p) => ({ type: p[0] === '+' ? 'add' : 'sub',
          left: l, right: p[1] }), left);
    }

MultiplicativeExpr
  = left:UnaryExpr
    rest:(_ op:("*" / DivKw / ModKw) _ r:UnaryExpr { return [op, r]; })* {
      return rest.reduce(
        (l, p) => ({ type: p[0] === '*' ? 'mul' : p[0],
          left: l, right: p[1] }), left);
    }

UnaryExpr
  = "-" _ e:UnaryExpr { return { type: 'neg', operand: e }; }
  / UnionExpr

UnionExpr
  = left:PathExpr rest:(_ "|" _ r:PathExpr { return r; })* {
      return rest.reduce(
        (l, r) => ({ type: 'unionExpr', left: l, right: r }), left);
    }

// FilterExpr-first ordering is load-bearing: a bare name must not
// parse as a FilterExpr prefix and leave a trailing '(' behind.
PathExpr
  = f:FilterExpr
    rest:(_ sep:("/" / "//") _ r:RelativeLocationPath {
      return [sep, r.steps]; })* {
      if (!rest.length) return f;
      const steps = [];
      for (const pair of rest) {
        const arr = pair[1];
        if (pair[0] === '//') arr[0].deep = true;
        steps.push(...arr);
      }
      return { type: 'filterPath', base: f, steps };
    }
  / LocationPath

FilterExpr
  = base:PrimaryExpr preds:Predicate* {
      return preds.length ?
        { type: 'filter', base, predicates: preds } : base;
    }

PrimaryExpr
  = "$" n:NCName {
      error("variable references are not allowed in patterns: $" + n);
    }
  / "(" _ e:Expr _ ")" { return e; }
  / l:LITERAL { return { type: 'str', value: l }; }
  / n:Number { return { type: 'num', value: +n }; }
  / FunctionCall

FunctionCall
  = name:NCName _ "(" _
    args:(e:Expr rest:(_ "," _ x:Expr { return x; })* {
      return [e].concat(rest); })?
    _ ")" {
      // XPath 1.0 core function library (plus id); key() is XSLT and
      // only legal at the top level of a pattern
      const CORE = ['id', 'last', 'position', 'count', 'local-name',
        'namespace-uri', 'name', 'string', 'concat', 'starts-with',
        'contains', 'substring-before', 'substring-after', 'substring',
        'string-length', 'normalize-space', 'translate', 'boolean',
        'not', 'true', 'false', 'lang', 'number', 'sum', 'floor',
        'ceiling', 'round'];
      if (name === 'key')
        error("key() is not allowed inside predicates; " +
          "it is only valid at the top level of a pattern");
      if (CORE.indexOf(name) === -1)
        error("function " + name + "() is not in the " +
          "supported XPath 1.0 core subset");
      return { type: 'call', name: name, args: args || [] };
    }

LocationPath
  = AbsoluteLocationPath
  / RelativeLocationPath

AbsoluteLocationPath
  = "//" _ rel:RelativeLocationPath {
      rel.steps[0].deep = true;
      return { type: 'path', from: 'root', steps: rel.steps };
    }
  / "/" _ rel:RelativeLocationPath {
      return { type: 'path', from: 'root', steps: rel.steps };
    }

RelativeLocationPath
  = first:Step
    rest:(_ sep:("/" / "//") _ s:Step { return [sep, s]; })* {
      const steps = [first];
      for (const pair of rest) {
        const step = pair[1];
        if (pair[0] === '//') step.deep = true;
        steps.push(step);
      }
      return { type: 'path', from: 'context', steps };
    }

Step
  = ".." { return { type: 'parent' }; }
  / "." { return { type: 'self' }; }
  / axis:StepAxisSpecifier test:NodeTest preds:Predicate* {
      return { type: 'step', axis, test, predicates: preds };
    }

// axes usable in predicate expressions; others fail loudly
StepAxisSpecifier
  = name:$('descendant-or-self' / 'descendant' / 'child' / 'attribute'
          / 'self' / 'parent') "::" { return name; }
  / other:$('ancestor-or-self' / 'ancestor' / 'following-sibling'
          / 'preceding-sibling' / 'following' / 'preceding'
          / 'namespace') "::" {
      error("axis " + other + ":: is not in the supported subset");
    }
  / "@" { return 'attribute'; }
  / "" { return 'child'; }

Number "number"
  = $(Digit+ ("." Digit*)? / "." Digit+)

LITERAL "string literal"
  = '"' s:$[^"]* '"' { return s; }
  / "'" s:$[^']* "'" { return s; }

Digit
  = [0-9]

// keywords are reserved when not part of a longer name
OrKw
  = "or" !NCNameChar { return 'or'; }

AndKw
  = "and" !NCNameChar { return 'and'; }

DivKw
  = "div" !NCNameChar { return 'div'; }

ModKw
  = "mod" !NCNameChar { return 'mod'; }

_ "whitespace"
  = [ \t\r\n]*