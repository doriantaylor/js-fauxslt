// FauXSLT module. Template processor with XSLT-like behaviour.
// See the README for the behavioural contract.

export { Registry } from './src/registry.js';
export { Context } from './src/context.js';
export { Template } from './src/template.js';
export { NamespaceMap, DEFAULT_NAMESPACES, XHTML_NAMESPACE,
  XML_NAMESPACE } from './src/namespaces.js';
export { compilePattern, UnsupportedPatternError,
  NotImplementedError } from './src/pattern.js';