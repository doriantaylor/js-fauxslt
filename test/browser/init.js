// browser-side module: loads the library and exposes it on window so
// playwright tests (which run in node) can drive it via evaluate()

import { Registry, Context } from '../../fauxslt.mjs';

window.fauxslt = { Registry, Context };
window.__ready = true;