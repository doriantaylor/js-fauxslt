// the transform exercised by the uniformity spec: the README
// example, verbatim. loaded at module load by both transform
// fixtures (HTML and XML-parsed XHTML), and set a readiness flag so
// tests can wait deterministically.
//
// note: on an HTML document this runs the no-rewrite path (bare
// names match namespace-less elements natively); on the XML-parsed
// XHTML fixture the same patterns and expressions are rewritten to
// `_:name` and resolved against the XHTML namespace — the uniform
// output is the whole point of the spec.

import { Transform } from 'fauxslt';

// sets up namespace mapping based on `document.documentElement`,
// plus some sane defaults; Does The Right Thing™ with (non-X)HTML.
const fauXSLT = window.fauXSLT = new Transform();

// suppose we have some out-of-band value
const isDraft = true;

// this is like <xsl:template match="…">
fauXSLT.registerMatch('body', (ctx) => {
    // note `this` is bound to an execution context,
    // which among other things has the current node
    const classes = Array.from(ctx.node.classList);

    // mess with css classes
    if (isDraft && !classes.includes('draft')) classes.push('draft');

    const header = ctx.copyOf('header') ||
          { '#header':
            { '#h1': ctx.select('normalize-space(/html/head/title)') } };

    let main = ctx.applyTemplates('.//main[not(@hidden)][1]') ||
        { '#main': ctx.callTemplate('article-shim') };

    const footer = { '#footer': 'copyright 2026 lol' };

    // return value can be a markup-mixup spec or DOM node
    // or DocumentFragment or whatever
    return { '#body': [header, main, footer], class: classes };
});

fauXSLT.registerMatch('main[not(@hidden)]', (ctx) => {
    // this returns an object we can use as a node spec
    const main = ctx.getAttributes();

    // comme ça
    main['#main'] = ctx.callTemplate('article-shim');
    return main;
});

// this is like <xsl:template name="…">
fauXSLT.registerNamed('article-shim', (ctx) => {
    const articles = ctx.select('count(.//article)');

    return articles === 1 ? ctx.applyTemplates('.//article[1]') :
        articles === 0 ? { '#article': ctx.applyTemplates() } :
    ctx.applyTemplates();
});

// now this will replace the body
fauXSLT.transform(document.body);

// readiness flag for the spec's deterministic wait
window.__transformed = true;