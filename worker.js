import { evaluate } from './engine.js';
self.onmessage = ({ data }) => {
  try { const start = performance.now(); const result = evaluate(data.config);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - start });
  } catch (error) { self.postMessage({ id: data.id, error: error.stack || String(error) }); }
};
