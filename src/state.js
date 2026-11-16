// Minimal shared state + pub/sub so app.js (3D viewport) and atlas.js
// (2D atlas tagging) can stay in separate files without a bundler.

export const store = {
  atlasImage: null,       // HTMLImageElement | null
  atlasImageURL: null,    // data URL, kept for project save/load
  atlasFileName: '',
  regions: [],            // { name, u0, v0, u1, v1 } normalized 0..1, v measured from top
};

const listeners = {};

export function on(event, fn) {
  (listeners[event] ||= []).push(fn);
}

export function emit(event, payload) {
  (listeners[event] || []).forEach((fn) => fn(payload));
}
