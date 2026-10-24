# FauXSLT

```js
import { Registry } from 'fauxslt';

// sets up namespace mapping based on `document.documentElement`,
// plus some sane defaults; Does The Right Thing™ with (non-X)HTML.
const fauXSLT = window.fauXSLT = new Registry();

// suppose we have some out-of-band value
const isDraft = true;

// this is like <xsl:template match="…">
fauXSLT.registerMatch('body', () => {
  // note `this` is bound to an execution context,
  // which among other things has the current node
  const classes = Array.from(this.node.classList);

  // mess with css classes
  if (isDraft && !('draft' in classes)) classes.push('draft');

  const header = this.copyOf('header') ||
    { '#header':
      { '#h1': this.applyTemplates('/html/head/title/text()') } };

  let main = this.applyTemplates('.//main[not(@hidden)][1]') ||
    { '#main': this.callTemplate('article-shim') };

  // return value can be a markup-mixup spec or DOM node
  // or DocumentFragment or whatever
  return { '#body': [header, main, footer], class: classes };
});

fauXSLT.registerMatch('main[not(@hidden)]', () => {
  // this returns an object we can use as a node spec
  const main = this.getAttributes();

  // comme ça
  main['#main'] = this.callTemplate('article-shim');
  return main;
});

// this is like <xsl:template name="…">
fauXSLT.registerNamed('article-shim', () => {
  const articles = this.select('count(.//article)');

  return articles === 1 ? this.applyTemplates('.//article[1]') :
    articles === 0 ? { '#article': this.applyTemplates() } :
    this.applyTemplates();
});

// now this will replace the body
fauXSLT.transform(document.body);
```
