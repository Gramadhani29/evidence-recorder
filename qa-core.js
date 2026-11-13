(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QA_CORE = api;
})(typeof self !== 'undefined' ? self : globalThis, function() {
  function imageFingerprint(data) {
    if (!data) return '';
    const size = data.size ?? data.length ?? 0;
    if (typeof data !== 'string') return `${data.type || 'blob'}:${size}`;
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(data.length / 2048));
    for (let i = 0; i < data.length; i += stride) {
      hash ^= data.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${data.length}:${(hash >>> 0).toString(16)}`;
  }

  function translateRects(rects, offsetX, offsetY, viewportW, viewportH) {
    return (rects || []).map(rect => ({
      ...rect,
      x: rect.x + offsetX,
      y: rect.y + offsetY,
      viewportW: viewportW || rect.viewportW,
      viewportH: viewportH || rect.viewportH
    }));
  }

  function shouldSkipCapture(previous, next, now = Date.now()) {
    if (!previous) return { skip: false };
    if (next.checkpointId && previous.checkpointId === next.checkpointId) return { skip: true, reason: 'checkpoint-id' };
    if (next.interactionId && next.phase && previous.interactionId === next.interactionId && previous.phase === next.phase) return { skip: true, reason: 'interaction-phase' };
    if (next.fingerprint && previous.fingerprint === next.fingerprint && now - previous.at < 2500) return { skip: true, reason: 'identical-image' };
    return { skip: false };
  }

  function renumberSteps(steps) {
    return (steps || []).map((step, index) => ({ ...step, stepNumber: index + 1 }));
  }

  return { imageFingerprint, translateRects, shouldSkipCapture, renumberSteps };
});
