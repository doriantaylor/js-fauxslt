// Template metadata for fauxslt. A template pairs an optional match
// pattern (XSLT <xsl:template match="…">) and/or a name
// (<xsl:template name="…">) with the function that runs when it is
// selected. Match expressions are compiled at construction time so
// invalid patterns throw at registration, not mid-transform.

import { compilePattern } from './pattern.js';

// registration counter: higher = more recent, which breaks ties in
// favour of the most recently registered template
let _order = 0;

export class Template {

  constructor ({ match = null, name = null, fn }) {
    if (typeof fn !== 'function')
      throw new TypeError('template requires a function');

    if (!match && !name)
      throw new Error(
        'template requires a match pattern, a name, or both');

    this.match = match ? compilePattern(match) : null;
    this.name = name;
    this.fn = fn;
    this.order = _order++;
  }

  get kind () {
    return this.match && this.name ? 'match+named' :
      this.match ? 'match' : 'named';
  }

  // identity used for registry storage and the match cache
  get key () {
    return this.name || this.match.expr;
  }
}