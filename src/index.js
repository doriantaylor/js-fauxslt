// FauXSLT module. Template processor with XSLT-like behaviour.
// See the README for the behavioural contract.

export { Transform } from './transform.js';
export { Context } from './context.js';
export { Template } from './template.js';
export { NamespaceMap, DEFAULT_NAMESPACES, XHTML_NAMESPACE,
  XHTML_PREFIX, XML_NAMESPACE } from './namespaces.js';
export { compilePattern, serializePattern, UnsupportedPatternError,
  NotImplementedError, XHTML_PREFIX as PATTERN_XHTML_PREFIX,
} from './pattern.js';
