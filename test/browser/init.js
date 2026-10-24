// browser-side module: loads the built single-file bundle (the
// shipped artifact) and exposes it on window so playwright tests
// (which run in node) can drive it via evaluate()

import * as fauxslt from '../../dist/fauxslt.js';

window.fauxslt = fauxslt;
window.__ready = true;

// expose a fresh copy of the current body HTML for tests that need to
// snapshot before/after
window.__snapshot = () => document.body.innerHTML;