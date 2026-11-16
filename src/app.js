import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/controls/OrbitControls.js';
import { OBJLoader } from './vendor/OBJLoader.js';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from './vendor/postprocessing/SSAOPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';
import { GLTFExporter } from './vendor/exporters/GLTFExporter.js';
import { refreshBakePreview } from './bake-colors.js';
import { undoPaint } from './texture-gen.js';
import { undoAtlas } from './atlas.js';
import { store, on, emit } from './state.js';
import './atlas.js';
import { restoreAtlasFromProject } from './atlas.js';
import './preferences.js';
import { getCardOutlineColor, getAutosaveEnabled, getAutosaveIntervalMin } from './preferences.js';

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('viewport-canvas');
const wrap = document.getElementById('viewport-canvas-wrap');
const hintEl = document.getElementById('viewport-hint');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101118);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(0, 0.1, 1.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Left button drives tools; right button orbits; wheel always zooms.
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

const hemiLight = new THREE.HemisphereLight(0xbfc6ff, 0x14141a, 1.1);
scene.add(hemiLight);
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(1.2, 1.5, 1.0);
scene.add(key);
// Shadow camera frustum sized for our ~1-unit head scale (shadows are only
// actually cast once "Soft shadows" is checked in the Render tab — see that
// checkbox's handler for where castShadow/shadowMap.enabled get switched on).
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 5;
key.shadow.camera.left = -1;
key.shadow.camera.right = 1;
key.shadow.camera.top = 1;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0015;

const gridHelper = new THREE.GridHelper(2, 20, 0x2a2d3a, 0x1c1e28);
gridHelper.position.y = -0.55;
scene.add(gridHelper);

// Post-processing: only used when Bloom is enabled from the Render tab.
// Bypassed entirely otherwise so the plain render path (cheaper) stays the
// default for everyday editing.
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ssaoPass = new SSAOPass(scene, camera, 512, 512);
ssaoPass.enabled = false;
composer.addPass(ssaoPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.4, 0.85);
bloomPass.enabled = false;
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
let bloomEnabled = false;
let aoEnabled = false;

// --- Secondary live-preview renderers (Hair tab, Render tab) ---
// Same scene as the main viewport, but with their OWN camera + OrbitControls
// — seeded once from the main camera's current view so they don't start
// looking at nothing, then fully independent from that point on so you can
// orbit around the head in these tabs without it fighting the main viewport.
const hairViewportCanvas = document.getElementById('hair-viewport-canvas');
const hairRenderer = new THREE.WebGLRenderer({ canvas: hairViewportCanvas, antialias: true });
hairRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const hairPreviewCamera = camera.clone();
const hairPreviewControls = new OrbitControls(hairPreviewCamera, hairViewportCanvas);
hairPreviewControls.target.copy(controls.target);
hairPreviewControls.enableDamping = true;
hairPreviewControls.dampingFactor = 0.08;
hairPreviewControls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

const renderViewportCanvas = document.getElementById('render-viewport-canvas');
const renderPreviewRenderer = new THREE.WebGLRenderer({ canvas: renderViewportCanvas, antialias: true });
renderPreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const renderPreviewCamera = camera.clone();
const renderPreviewControls = new OrbitControls(renderPreviewCamera, renderViewportCanvas);
renderPreviewControls.target.copy(controls.target);
renderPreviewControls.enableDamping = true;
renderPreviewControls.dampingFactor = 0.08;
renderPreviewControls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// The Render tab preview is meant to show your actual final look before
// export, so it needs its OWN composer — EffectComposer is tied to one
// specific renderer/canvas, it can't be shared with the main viewport's.
const renderPreviewComposer = new EffectComposer(renderPreviewRenderer);
const renderPreviewRenderPass = new RenderPass(scene, renderPreviewCamera);
renderPreviewComposer.addPass(renderPreviewRenderPass);
const renderPreviewSsaoPass = new SSAOPass(scene, renderPreviewCamera, 512, 512);
renderPreviewSsaoPass.enabled = false;
renderPreviewComposer.addPass(renderPreviewSsaoPass);
const renderPreviewBloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.4, 0.85);
renderPreviewBloomPass.enabled = false;
renderPreviewComposer.addPass(renderPreviewBloomPass);
renderPreviewComposer.addPass(new OutputPass());

// --- Right-mouse-button hotkeys (Substance-Painter-style), shared across
// all three viewports: plain right-drag orbits (OrbitControls' own default,
// untouched here); Shift+right-drag rotates the key light horizontally;
// Alt+right-drag or Ctrl+right-drag pans the camera instead of orbiting.
function setupCameraHotkeys(canvasEl, cam, orbitControls) {
  canvasEl.addEventListener('contextmenu', (evt) => evt.preventDefault());

  let mode = null; // 'pan' | 'light' | null (null = let OrbitControls orbit normally)
  let lastPos = null;

  canvasEl.addEventListener('mousedown', (evt) => {
    if (evt.button !== 2) return; // right button only
    if (evt.shiftKey) {
      mode = 'light';
      orbitControls.enabled = false;
    } else if (evt.altKey || evt.ctrlKey) {
      mode = 'pan';
      orbitControls.enabled = false;
    } else {
      mode = null;
      orbitControls.enabled = true; // plain right-drag: OrbitControls' own ROTATE handles it
    }
    lastPos = { x: evt.clientX, y: evt.clientY };
  });

  window.addEventListener('mousemove', (evt) => {
    if (!mode || !lastPos) return;
    const dx = evt.clientX - lastPos.x;
    const dy = evt.clientY - lastPos.y;
    lastPos = { x: evt.clientX, y: evt.clientY };

    if (mode === 'light') {
      key.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), dx * 0.008);
    } else if (mode === 'pan') {
      const camRight = new THREE.Vector3();
      const camUp = new THREE.Vector3();
      cam.matrixWorld.extractBasis(camRight, camUp, new THREE.Vector3());
      const dist = cam.position.distanceTo(orbitControls.target);
      const panScale = dist * 0.0015;
      const offset = camRight.multiplyScalar(-dx * panScale).add(camUp.multiplyScalar(dy * panScale));
      cam.position.add(offset);
      orbitControls.target.add(offset);
    }
  });

  window.addEventListener('mouseup', (evt) => {
    if (evt.button !== 2) return;
    mode = null;
    lastPos = null;
    orbitControls.enabled = true;
  });
}

setupCameraHotkeys(canvas, camera, controls);
setupCameraHotkeys(hairViewportCanvas, hairPreviewCamera, hairPreviewControls);
setupCameraHotkeys(renderViewportCanvas, renderPreviewCamera, renderPreviewControls);

function resizeSecondaryViewport(which) {
  const wrap = document.getElementById(`${which}-viewport-wrap`);
  const r = which === 'hair' ? hairRenderer : renderPreviewRenderer;
  if (!wrap.clientWidth || !wrap.clientHeight) return;
  const last = secondaryViewportSizes[which];
  if (last.w === wrap.clientWidth && last.h === wrap.clientHeight) return;
  last.w = wrap.clientWidth; last.h = wrap.clientHeight;
  r.setSize(wrap.clientWidth, wrap.clientHeight, false);
  if (which === 'render') renderPreviewComposer.setSize(wrap.clientWidth, wrap.clientHeight);
}
const secondaryViewportSizes = { hair: { w: 0, h: 0 }, render: { w: 0, h: 0 } };
new ResizeObserver(() => resizeSecondaryViewport('hair')).observe(document.getElementById('hair-viewport-wrap'));
new ResizeObserver(() => resizeSecondaryViewport('render')).observe(document.getElementById('render-viewport-wrap'));

// "Render Quality" — honestly, this is still WebGL either way (see the note
// in the Render tab UI). "High" raises pixel ratio (real, visible sharpening/
// supersampling effect) on all three canvases.
document.getElementById('render-quality-mode').addEventListener('change', (evt) => {
  const high = evt.target.value === 'high';
  const ratio = Math.min(window.devicePixelRatio, high ? 3 : 2);
  renderer.setPixelRatio(ratio);
  renderPreviewRenderer.setPixelRatio(ratio);
  hairRenderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  renderPreviewComposer.setPixelRatio(ratio);
});

document.getElementById('render-ao-enabled').addEventListener('change', (evt) => {
  aoEnabled = evt.target.checked;
  ssaoPass.enabled = aoEnabled;
  renderPreviewSsaoPass.enabled = aoEnabled;
});

document.getElementById('render-shadows-enabled').addEventListener('change', (evt) => {
  const on = evt.target.checked;
  [renderer, hairRenderer, renderPreviewRenderer].forEach((r) => {
    r.shadowMap.enabled = on;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
  });
  key.castShadow = on;
  // Existing materials need a re-compile to pick up the shadow-map change.
  guides.forEach((g) => g.cardsGroup.children.forEach((c) => { c.material.needsUpdate = true; }));
  headMesh.material.needsUpdate = true;
});

// Head/scalp proxy — starts as an ellipsoid fallback so the viewport isn't
// empty while the real head mesh loads, then swapped for the actual asset.
const HEAD_RADIUS = 0.5;
const headGeo = new THREE.SphereGeometry(HEAD_RADIUS, 48, 36);
headGeo.scale(0.82, 1.0, 0.9);
const headMat = new THREE.MeshStandardMaterial({
  color: 0xd9b48f,
  roughness: 0.85,
  metalness: 0.05,
  side: THREE.DoubleSide, // needed so inside-out raycasts (see headSurfaceRadiusAt) register hits
});
const headMesh = new THREE.Mesh(headGeo, headMat);
headMesh.castShadow = true;
headMesh.receiveShadow = true;
headMesh.position.set(0, 0.15, 0);
scene.add(headMesh);
const headCenter = headMesh.position.clone();

function applyHeadObjGroup(obj) {
  // Merge all sub-meshes into one BufferGeometry so raycasting/collision
  // logic (which targets a single `headMesh`) keeps working unchanged.
  const geometries = [];
  obj.traverse((child) => {
    if (child.isMesh) geometries.push(child.geometry);
  });
  if (geometries.length === 0) return false;

  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);

  // Recenter on its own bounding-box middle, then scale so its vertical
  // extent matches the placeholder sphere's (1.0) — keeps existing
  // brush-radius / card-width / density defaults feeling right-sized
  // regardless of which head model is loaded.
  merged.computeBoundingBox();
  const bbox = merged.boundingBox;
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);

  const yExtent = bbox.max.y - bbox.min.y;
  const scale = yExtent > 0 ? 1.0 / yExtent : 1;
  merged.scale(scale, scale, scale);
  // NOTE: deliberately not calling computeVertexNormals() here — a merged,
  // non-indexed geometry would get flat per-face normals from that, wiping
  // out any smooth shading baked into the source OBJ's vn data. Uniform
  // scale and translation don't change normal directions, so whatever
  // normals came from the file (or mergeGeometries' copy of them) stay valid.

  headMesh.geometry.dispose();
  headMesh.geometry = merged;
  return true;
}

new OBJLoader().load(
  './assets/head_placeholder.obj',
  (obj) => applyHeadObjGroup(obj),
  undefined,
  (err) => console.warn('Head mesh failed to load, keeping ellipsoid fallback:', err)
);

// Minimal single-geometry merge (positions + normals + uv), enough for a
// plain imported OBJ with no skinning/morphs. Avoids pulling in the full
// three.js BufferGeometryUtils module for one function.
function mergeGeometries(geoms) {
  let totalVerts = 0;
  geoms.forEach((g) => { totalVerts += g.getAttribute('position').count; });

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  let offset = 0, offsetUV = 0;

  geoms.forEach((g) => {
    const posAttr = g.getAttribute('position');
    const normAttr = g.getAttribute('normal');
    const uvAttr = g.getAttribute('uv');
    positions.set(posAttr.array, offset);
    if (normAttr) normals.set(normAttr.array, offset);
    if (uvAttr) uvs.set(uvAttr.array, offsetUV);
    offset += posAttr.array.length;
    offsetUV += posAttr.count * 2;
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return merged;
}

function resize() {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  composer.setSize(w, h);
}
new ResizeObserver(resize).observe(wrap);
resize();

// --- Draggable panel borders (Viewport tab's left/right side panels) ---
document.querySelectorAll('.resize-handle').forEach((handle) => {
  const targetEl = document.getElementById(handle.dataset.resizeTarget);
  const side = handle.dataset.resizeSide; // 'left' panel grows with the mouse moving right; 'right' panel grows moving left
  let startX = 0, startWidth = 0, dragging = false;

  handle.addEventListener('mousedown', (evt) => {
    dragging = true;
    handle.classList.add('dragging');
    startX = evt.clientX;
    startWidth = targetEl.getBoundingClientRect().width;
    evt.preventDefault();
  });

  window.addEventListener('mousemove', (evt) => {
    if (!dragging) return;
    const delta = evt.clientX - startX;
    const newWidth = side === 'left' ? startWidth + delta : startWidth - delta;
    targetEl.style.width = `${Math.max(160, Math.min(560, newWidth))}px`;
    // The canvas wrap's ResizeObserver picks this up automatically, but
    // nudge it immediately so dragging feels responsive frame-to-frame.
    resize();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
  });
});

// --- Draggable vertical borders (e.g. the Guide list, which was getting
// squeezed by everything else in the left panel) ---
document.querySelectorAll('.resize-handle-v').forEach((handle) => {
  const targetEl = document.getElementById(handle.dataset.resizeTargetV);
  let startY = 0, startHeight = 0, dragging = false;

  handle.addEventListener('mousedown', (evt) => {
    dragging = true;
    handle.classList.add('dragging');
    startY = evt.clientY;
    startHeight = targetEl.getBoundingClientRect().height;
    evt.preventDefault();
  });

  window.addEventListener('mousemove', (evt) => {
    if (!dragging) return;
    const delta = evt.clientY - startY;
    targetEl.style.flex = `0 0 ${Math.max(80, Math.min(600, startHeight + delta))}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
  });
});

// ---------------------------------------------------------------------------
// Guide model
// ---------------------------------------------------------------------------

let guideCounter = 0;
const guides = [];
let selectedGuide = null;
const selectedGuideSet = new Set(); // multi-select: Ctrl+click a guide, or click a layer to grab all its guides

// Guides that property edits (sliders/checkboxes/regenerate/delete) should
// apply to. Falls back to just the primary selection when nothing's multi-selected.
function guidesToEdit() {
  return selectedGuideSet.size > 0 ? Array.from(selectedGuideSet) : (selectedGuide ? [selectedGuide] : []);
}
let activeMode = 'place'; // 'place' | 'comb' | 'drag' | 'manual'

let nextLayerId = 1; // 0 is taken by the initial "Layer 1"
const layers = [{ id: 0, name: 'Layer 1' }];
let activeLayerId = 0;

const GUIDE_COLORS = [0xb968ff, 0xf2b84b, 0x63d2ff, 0x8fe388, 0xff8fb1, 0xffd76b];

function makeGuide() {
  const id = guideCounter++;
  const color = GUIDE_COLORS[id % GUIDE_COLORS.length];

  const lineGeo = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(lineGeo, lineMat);
  scene.add(line);

  const pointsGroup = new THREE.Group();
  scene.add(pointsGroup);

  const cardsGroup = new THREE.Group();
  scene.add(cardsGroup);

  const guide = {
    id,
    layerId: activeLayerId,
    color,
    points: [],       // THREE.Vector3[]
    prevPoints: [],   // for verlet integration
    restLengths: [],  // segment lengths captured at author-time (place/comb), NOT recomputed during physics
    locked: false,    // true once user starts a new guide or switches modes away from placing
    line,
    pointsGroup,
    cardsGroup,
    length: 1.0,      // stretches the guide outward from its root when generating cards/preview
    density: 6,
    cardWidth: 0.045,
    spread: 0.03,
    taper: true,
    atlasRegionIndex: -1,
    mirrorOf: null, // Symmetry Mode: the paired guide on the opposite side, if any
  };
  guides.push(guide);
  const topoVisible = document.getElementById('show-topology').checked;
  line.visible = topoVisible;
  pointsGroup.visible = topoVisible;
  return guide;
}

// Scales points[1..] away from the root (points[0]) by guide.length, without
// mutating the underlying placed/physics points. Used for the guide-line
// preview and card generation only — physics/comb/rest-lengths always use
// the raw guide.points.
function getScaledPoints(guide) {
  if (guide.points.length === 0) return [];
  const root = guide.points[0];
  if (guide.length === 1) return guide.points;
  return guide.points.map((p, i) => (i === 0 ? p.clone() : root.clone().addScaledVector(p.clone().sub(root), guide.length)));
}

// ---------------------------------------------------------------------------
// Undo (Ctrl+Z): snapshot-based history of guide/layer state.
//
// SCOPE NOTE: this covers guide edits — placement, comb/drag, property
// sliders, new/delete guide, layers. It does NOT cover Manual Edit mode's
// per-card vertex/subdivide edits, or the Atlas/Texture Generator tabs —
// those aren't captured in the snapshot. "Regenerate Cards" is undoable for
// the guide state that produced it, but since each card's jitter is random,
// the exact visual scatter after undo may differ slightly from before.
// ---------------------------------------------------------------------------

const undoStack = [];
const MAX_UNDO = 50;
let snapshotPending = false; // collapses a whole slider-drag/mouse-drag gesture into one undo step

function serializeState() {
  return {
    layers: layers.map((l) => ({ ...l })),
    activeLayerId,
    guides: guides.map((g) => ({
      layerId: g.layerId,
      length: g.length,
      points: g.points.map((p) => [p.x, p.y, p.z]),
      density: g.density,
      cardWidth: g.cardWidth,
      spread: g.spread,
      taper: g.taper,
      atlasRegionIndex: g.atlasRegionIndex,
    })),
  };
}

function pushUndoSnapshot() {
  undoStack.push(serializeState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// Call at the start of a drag-like gesture (slider drag, comb/drag-mode
// mouse drag) so the whole gesture undoes in one Ctrl+Z, not one step per
// tiny movement. Resets on mouseup.
function beginUndoableEdit() {
  if (!snapshotPending) {
    pushUndoSnapshot();
    snapshotPending = true;
  }
}
window.addEventListener('mouseup', () => { snapshotPending = false; });

function restoreState(state) {
  guides.slice().forEach((g) => scene.remove(g.line, g.pointsGroup, g.cardsGroup));
  guides.length = 0;
  guideCounter = 0;

  layers.length = 0;
  layers.push(...state.layers.map((l) => ({ ...l })));
  nextLayerId = Math.max(0, ...layers.map((l) => l.id)) + 1;
  activeLayerId = state.activeLayerId;

  state.guides.forEach((gd) => {
    const guide = makeGuide();
    guide.layerId = gd.layerId;
    guide.length = gd.length;
    guide.points = gd.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    guide.density = gd.density;
    guide.cardWidth = gd.cardWidth;
    guide.spread = gd.spread;
    guide.taper = gd.taper;
    guide.atlasRegionIndex = gd.atlasRegionIndex;
    guide.locked = true;
    syncPointMeshes(guide);
    refreshGuideLine(guide);
    computeRestLengths(guide);
    regenerateCards(guide);
  });
  selectGuide(guides[guides.length - 1] || null);
  updateBudgetDashboard();
}

function undo() {
  if (undoStack.length === 0) {
    hintEl.textContent = 'Nothing to undo.';
    return;
  }
  restoreState(undoStack.pop());
  hintEl.textContent = `Undid last change (${undoStack.length} more available).`;
}

window.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey) || evt.code !== 'KeyZ' || evt.shiftKey) return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  evt.preventDefault();

  const activeTabBtn = document.querySelector('.tab-btn.active');
  const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'viewport';

  if (activeTab === 'texturegen') {
    if (!undoPaint()) hintEl.textContent = 'Nothing to undo in Texture Canva.';
  } else if (activeTab === 'atlas') {
    if (!undoAtlas()) hintEl.textContent = 'Nothing to undo in Atlas Editor.';
  } else {
    undo(); // guide/layer undo — covers Viewport, Hair, Render, Bake & Colors, Export
  }
});

// Delete/Backspace: deletes the selected card in Manual Edit mode (if one is
// selected), otherwise deletes the currently selected guide(s).
window.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Delete' && evt.key !== 'Backspace') return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  evt.preventDefault();

  if (activeMode === 'manual' && selectedCard) {
    deleteSelectedCard();
  } else {
    deleteSelectedGuides();
  }
});

function addPointMesh(guide, position, outlined) {
  const geo = new THREE.SphereGeometry(0.008, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ color: guide.color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  guide.pointsGroup.add(mesh);
  if (outlined) {
    // Backface-halo technique: a slightly larger sphere rendered only from
    // the inside shows as a thin outline ring around the marker.
    const outlineGeo = new THREE.SphereGeometry(0.008 * 1.6, 10, 8);
    const outlineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
    mesh.add(new THREE.Mesh(outlineGeo, outlineMat));
  }
}

function refreshGuideLine(guide) {
  if (guide.points.length < 2) {
    guide.line.geometry.setFromPoints(guide.points);
    return;
  }
  const scaled = getScaledPoints(guide);
  const curve = new THREE.CatmullRomCurve3(scaled);
  const pts = curve.getPoints(Math.max(20, scaled.length * 8));
  guide.line.geometry.setFromPoints(pts);
}

// Captures each segment's "resting" length from wherever the guide currently
// is. Called after authoring moves (place / comb), never during the physics
// step itself — otherwise the constraint has nothing to restore toward.
function computeRestLengths(guide) {
  guide.restLengths = [];
  for (let i = 1; i < guide.points.length; i++) {
    guide.restLengths.push(guide.points[i - 1].distanceTo(guide.points[i]));
  }
}

function syncPointMeshes(guide) {
  guide.pointsGroup.clear();
  const isSelected = selectedGuideSet.has(guide) || guide === selectedGuide;
  guide.points.forEach((p) => addPointMesh(guide, p, isSelected));
}

// Called whenever the guide/layer selection changes — rebuilds every guide's
// point markers so outlines show up on newly-selected guides and disappear
// from deselected ones.
function refreshAllGuideMarkerOutlines() {
  guides.forEach((g) => syncPointMeshes(g));
}

// ---------------------------------------------------------------------------
// Card generation
// ---------------------------------------------------------------------------

let atlasTexture = null;
let atlasTextureSourceImage = null;

function getAtlasTexture() {
  if (!store.atlasImage) return null;
  if (atlasTexture && atlasTextureSourceImage === store.atlasImage) return atlasTexture;
  atlasTexture = new THREE.Texture(store.atlasImage);
  atlasTexture.flipY = !document.getElementById('atlas-flip-v').checked;
  atlasTexture.needsUpdate = true;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTextureSourceImage = store.atlasImage;
  return atlasTexture;
}

document.getElementById('btn-import-head-model').addEventListener('click', async () => {
  const result = await window.hcsAPI.importHeadModel();
  if (!result) return;
  const obj = new OBJLoader().parse(result.content);
  const ok = applyHeadObjGroup(obj);
  hintEl.textContent = ok
    ? `Loaded head model: ${result.filePath}`
    : `Could not find any mesh data in ${result.filePath}`;
});

document.getElementById('btn-import-head-texture').addEventListener('click', async () => {
  const result = await window.hcsAPI.importHeadTexture();
  if (!result) return;
  const mime = result.ext === '.jpg' || result.ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const img = new Image();
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    headMesh.material.map = tex;
    headMesh.material.color.set(0xffffff); // texture carries the color now — a tinted base would darken/shift it
    headMesh.material.needsUpdate = true;
    hintEl.textContent = `Loaded head texture: ${result.filePath}`;
  };
  img.src = `data:${mime};base64,${result.data}`;
});

document.getElementById('atlas-flip-v').addEventListener('change', (evt) => {
  if (atlasTexture) {
    atlasTexture.flipY = !evt.target.checked;
    atlasTexture.needsUpdate = true;
  }
  // Cards were built with UVs baked against the old orientation, so they
  // need a real regenerate — a texture-property flip alone doesn't fix
  // geometry that already has UVs authored for the other direction.
  guides.forEach((g) => regenerateCards(g));
  updateBudgetDashboard();
});

// Editing-only visual scale for cards — never touches the real cardWidth/
// height data (guide.cardWidth, budget stats, or OBJ export all use the
// true, unscaled geometry). Just makes thin/small hair actually visible
// while working, without lying about real in-engine dimensions.
let cardVisibilityBoost = 6;
function applyCardScale(card) {
  card.scale.setScalar(cardVisibilityBoost * (card.userData.manualScale || 1));
}

// Always-visible outline on every card (distinct from the gold Manual Edit
// selection highlight, which only shows on the one currently-selected
// card). Color is user-configurable via Edit > Preferences.
let cardOutlineColor = getCardOutlineColor();

function addCardOutline(card) {
  if (card.userData.outline) {
    card.remove(card.userData.outline);
    card.userData.outline.geometry.dispose();
    card.userData.outline.material.dispose();
  }
  const wire = new THREE.WireframeGeometry(card.geometry);
  const outline = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: cardOutlineColor, transparent: true, opacity: 0.6 }));
  outline.raycast = () => {}; // exclude from raycasting — Three.js recurses into children by default, and this coincides exactly with the card surface, which would otherwise sometimes steal the hit
  card.add(outline);
  card.userData.outline = outline;
}

window.addEventListener('card-outline-color-changed', (evt) => {
  cardOutlineColor = evt.detail;
  guides.forEach((g) => g.cardsGroup.children.forEach((card) => {
    if (card.userData.outline) card.userData.outline.material.color.set(cardOutlineColor);
  }));
});

function regenerateCards(guide) {
  guide.cardsGroup.clear();
  if (guide.points.length < 2) return;

  const curve = new THREE.CatmullRomCurve3(getScaledPoints(guide));
  const n = Math.max(1, guide.density);
  const samples = curve.getSpacedPoints(n);
  const tangents = samples.map((_, i) => {
    const t = i / n;
    return curve.getTangent(Math.min(0.999, Math.max(0.001, t))).normalize();
  });

  const segLength = curve.getLength() / n;
  const cardHeight = segLength * 1.35; // slight overlap, like real hair card strips

  const region = guide.atlasRegionIndex >= 0 ? store.regions[guide.atlasRegionIndex] : null;
  const tex = getAtlasTexture();

  const material = new THREE.MeshStandardMaterial({
    color: tex ? 0xffffff : guide.color,
    map: tex || null,
    transparent: true,
    alphaTest: tex ? 0.35 : 0,
    side: THREE.FrontSide, // geometry itself is two-sided now (see makeTwoSidedPlaneGeometry) — cheaper and export-safe
    roughness: 0.6,
  });

  for (let i = 0; i < samples.length; i++) {
    const pos = samples[i];
    const tangent = tangents[i];
    const outward = pos.clone().sub(headCenter).normalize();
    // Re-orthogonalize so the card stays flat and stable even when tangent
    // and outward nearly align near the tip.
    const right = new THREE.Vector3().crossVectors(tangent, outward).normalize();
    const normal = new THREE.Vector3().crossVectors(right, tangent).normalize();

    const taperFactor = guide.taper ? 1 - 0.55 * (i / Math.max(1, samples.length - 1)) : 1;
    const w = guide.cardWidth * taperFactor;

    const geo = makeTwoSidedPlaneGeometry(w, cardHeight);
    if (region) remapUVs(geo, region);

    const basis = new THREE.Matrix4().makeBasis(right, tangent, normal);
    geo.applyMatrix4(basis);

    const jitter = (Math.random() - 0.5) * guide.spread;
    const rotJitter = (Math.random() - 0.5) * 0.6; // radians, around tangent

    const card = new THREE.Mesh(geo, material);
    card.position.copy(pos).addScaledVector(right, jitter);
    card.rotateOnAxis(tangent, rotJitter);
    card.userData = {
      guide,
      basisMatrix: basis.clone(),
      manualScale: 1, // separate from cardVisibilityBoost (an editing aid) — see applyCardScale
      width: w,
      height: cardHeight,
      region,
      segments: 1,       // heightSegments; >1 once subdivided in Manual mode
      prevLocal: null,   // verlet history for manual-card gravity
      pinnedRow: 0,      // which grid row stays fixed (closest to the scalp)
      sampleIndex: i,    // which curve sample this card was generated from
      jitter,
      rotJitter,
    };
    applyCardScale(card);
    addCardOutline(card);
    card.castShadow = true;
    card.receiveShadow = true;
    guide.cardsGroup.add(card);
  }
}

// Re-samples the guide's (possibly-moving) curve and moves each existing
// auto-generated card to match — called every physics tick so cards actually
// follow the guide during live simulation instead of staying where they were
// first generated. Reuses each card's original jitter/rotJitter so this
// doesn't look like re-randomized noise every frame. Manually-subdivided
// cards (Manual Edit mode) are left alone; they're independently deformed.
function repositionAutoCards(guide) {
  if (guide.points.length < 2 || guide.cardsGroup.children.length === 0) return;

  const curve = new THREE.CatmullRomCurve3(getScaledPoints(guide));
  const n = guide.cardsGroup.children.length;

  guide.cardsGroup.children.forEach((card) => {
    if (card.userData.segments > 1) return; // manually subdivided — skip
    const i = card.userData.sampleIndex;
    const t = Math.min(0.999, Math.max(0.001, i / n));
    const pos = curve.getPointAt(Math.min(1, i / Math.max(1, n - 1)));
    const tangent = curve.getTangent(t).normalize();
    const outward = pos.clone().sub(headCenter).normalize();
    const right = new THREE.Vector3().crossVectors(tangent, outward).normalize();
    const normal = new THREE.Vector3().crossVectors(right, tangent).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, tangent, normal);

    // Rebuild geometry with the new basis (cheap: it's a tiny plane), then
    // reapply the SAME jitter/rotation the card was created with.
    const geo = makeTwoSidedPlaneGeometry(card.userData.width, card.userData.height);
    if (card.userData.region) remapUVs(geo, card.userData.region);
    geo.applyMatrix4(basis);
    card.geometry.dispose();
    card.geometry = geo;
    card.userData.basisMatrix = basis;

    card.position.copy(pos).addScaledVector(right, card.userData.jitter);
    card.rotation.set(0, 0, 0);
    card.rotateOnAxis(tangent, card.userData.rotJitter);
  });
}

// Real two-sided geometry: duplicates every triangle with reversed winding
// (and flips the corresponding normals) so the card is genuinely visible
// and correctly lit from both sides via mesh topology — not a
// material.side=DoubleSide flag, which OBJ/MTL export can't reliably carry
// into other engines (there's no standard "double sided" attribute in that
// format). This doubles each card's triangle count; Budget Dashboard and
// OBJ export both account for that.
// Merges indexed BufferGeometries, correctly offsetting each one's index
// buffer by the running vertex count — NOT the same as the existing
// mergeGeometries() above, which assumes non-indexed input (used for the
// imported head OBJ) and would silently mis-triangulate indexed geometry.
function mergeIndexedGeometries(geoms) {
  let totalVerts = 0, totalIndices = 0;
  geoms.forEach((g) => { totalVerts += g.getAttribute('position').count; totalIndices += g.getIndex().count; });

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0, uvOffset = 0, iOffset = 0, vertexCountSoFar = 0;
  geoms.forEach((g) => {
    const posAttr = g.getAttribute('position');
    const normAttr = g.getAttribute('normal');
    const uvAttr = g.getAttribute('uv');
    const idxAttr = g.getIndex();

    positions.set(posAttr.array, vOffset);
    if (normAttr) normals.set(normAttr.array, vOffset);
    if (uvAttr) uvs.set(uvAttr.array, uvOffset);
    for (let i = 0; i < idxAttr.count; i++) indices[iOffset + i] = idxAttr.getX(i) + vertexCountSoFar;

    vOffset += posAttr.array.length;
    uvOffset += posAttr.count * 2;
    iOffset += idxAttr.count;
    vertexCountSoFar += posAttr.count;
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

function makeTwoSidedPlaneGeometry(width, height, widthSegments, heightSegments) {
  const front = new THREE.PlaneGeometry(width, height, widthSegments || 1, heightSegments || 1);
  const back = front.clone();

  const normAttr = back.getAttribute('normal');
  for (let i = 0; i < normAttr.count; i++) {
    normAttr.setXYZ(i, -normAttr.getX(i), -normAttr.getY(i), -normAttr.getZ(i));
  }
  normAttr.needsUpdate = true;
  const backIndex = back.getIndex();
  const reversed = new Uint32Array(backIndex.count);
  for (let i = 0; i < backIndex.count; i += 3) {
    reversed[i] = backIndex.getX(i);
    reversed[i + 1] = backIndex.getX(i + 2);
    reversed[i + 2] = backIndex.getX(i + 1);
  }
  back.setIndex(new THREE.BufferAttribute(reversed, 1));

  return mergeIndexedGeometries([front, back]);
}

function remapUVs(geometry, region) {
  const uvAttr = geometry.getAttribute('uv');
  for (let i = 0; i < uvAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    uvAttr.setXY(
      i,
      region.u0 + u * (region.u1 - region.u0),
      // Canvas v is measured from the top; flip so texture reads right-side up.
      1 - (region.v0 + (1 - v) * (region.v1 - region.v0))
    );
  }
  uvAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Selection / UI wiring
// ---------------------------------------------------------------------------

const guideListEl = document.getElementById('guide-list');
const lengthSlider = document.getElementById('length-slider');
const lengthVal = document.getElementById('length-val');
const densitySlider = document.getElementById('density-slider');
const densityVal = document.getElementById('density-val');
const cardWidthSlider = document.getElementById('card-width');
const cardWidthVal = document.getElementById('card-width-val');
const spreadSlider = document.getElementById('spread');
const spreadVal = document.getElementById('spread-val');
const taperToggle = document.getElementById('taper-toggle');
const atlasSliceSelect = document.getElementById('atlas-slice-select');

const budgetTargetSlider = document.getElementById('budget-target');
const budgetTargetVal = document.getElementById('budget-target-val');
const budgetCardsEl = document.getElementById('budget-cards');
const budgetQuadsEl = document.getElementById('budget-quads');
const budgetTrisEl = document.getElementById('budget-tris');
const budgetVertsEl = document.getElementById('budget-verts');
const budgetTexMemEl = document.getElementById('budget-texmem');
const budgetStatusEl = document.getElementById('budget-status');

const cardBoostSlider = document.getElementById('card-boost');
const cardBoostVal = document.getElementById('card-boost-val');
cardBoostSlider.addEventListener('input', () => {
  cardVisibilityBoost = Number(cardBoostSlider.value);
  cardBoostVal.textContent = `${cardVisibilityBoost.toFixed(1)}×`;
  guides.forEach((g) => g.cardsGroup.children.forEach((card) => applyCardScale(card)));
});

function updateBudgetDashboard() {
  let totalCards = 0, totalTris = 0, totalVerts = 0;
  guides.forEach((g) => {
    totalCards += g.cardsGroup.children.length;
    g.cardsGroup.children.forEach((card) => {
      const idx = card.geometry.getIndex();
      totalTris += idx ? idx.count / 3 : 0;
      totalVerts += card.geometry.getAttribute('position').count;
    });
  });
  const totalQuads = totalTris / 2; // every quad in our plane-grid geometry is exactly 2 triangles

  budgetCardsEl.textContent = totalCards;
  budgetQuadsEl.textContent = totalQuads;
  budgetTrisEl.textContent = totalTris;
  budgetVertsEl.textContent = totalVerts;

  if (store.atlasImage) {
    const w = store.atlasImage.width;
    const h = store.atlasImage.height;
    // RGBA8 + ~33% for the mip chain, shared by every card (one texture, one material).
    const mb = (w * h * 4 * 1.33) / (1024 * 1024);
    budgetTexMemEl.textContent = `${w}×${h} · ${mb.toFixed(1)} MB`;
  } else {
    budgetTexMemEl.textContent = '— (no atlas loaded)';
  }

  const target = Number(budgetTargetSlider.value);
  budgetStatusEl.classList.remove('ok', 'warn', 'over');
  if (totalCards === 0) {
    budgetStatusEl.textContent = 'No cards generated yet';
  } else if (totalCards <= target * 0.85) {
    budgetStatusEl.textContent = `Within budget (${totalCards} / ${target})`;
    budgetStatusEl.classList.add('ok');
  } else if (totalCards <= target) {
    budgetStatusEl.textContent = `Near budget (${totalCards} / ${target})`;
    budgetStatusEl.classList.add('warn');
  } else {
    budgetStatusEl.textContent = `Over budget (${totalCards} / ${target})`;
    budgetStatusEl.classList.add('over');
  }
}

budgetTargetSlider.addEventListener('input', () => {
  budgetTargetVal.textContent = budgetTargetSlider.value;
  updateBudgetDashboard();
});

function syncInputsFromGuide(guide) {
  if (!guide) return;
  lengthSlider.value = guide.length;
  lengthVal.textContent = guide.length.toFixed(2);
  densitySlider.value = guide.density;
  densityVal.textContent = guide.density;
  cardWidthSlider.value = guide.cardWidth;
  cardWidthVal.textContent = guide.cardWidth.toFixed(3);
  spreadSlider.value = guide.spread;
  spreadVal.textContent = guide.spread.toFixed(3);
  taperToggle.checked = guide.taper;
  atlasSliceSelect.value = guide.atlasRegionIndex;
}

function updateGuideLineHighlights() {
  guides.forEach((g) => {
    g.line.material.linewidth = selectedGuideSet.has(g) ? 2 : 1;
  });
}

function selectGuide(guide) {
  selectedGuide = guide;
  selectedGuideSet.clear();
  if (guide) selectedGuideSet.add(guide);
  updateGuideLineHighlights();
  refreshAllGuideMarkerOutlines();
  if (guide) {
    syncInputsFromGuide(guide);
    activeLayerId = guide.layerId;
  }
  refreshGuideList();
}

// Ctrl/Cmd+click a guide in the list: add/remove it from the multi-selection
// without disturbing the rest of it.
function toggleGuideSelection(guide) {
  if (selectedGuideSet.has(guide)) {
    selectedGuideSet.delete(guide);
  } else {
    selectedGuideSet.add(guide);
  }
  selectedGuide = guide;
  updateGuideLineHighlights();
  refreshAllGuideMarkerOutlines();
  if (selectedGuideSet.has(guide)) syncInputsFromGuide(guide);
  refreshGuideList();
}

// Click a layer header: select every guide in it at once, so sliders/toggles
// below apply to the whole layer in one go instead of guide-by-guide.
function selectLayerGuides(layerId) {
  selectedGuideSet.clear();
  const layerGuides = guides.filter((g) => g.layerId === layerId);
  layerGuides.forEach((g) => selectedGuideSet.add(g));
  selectedGuide = layerGuides[0] || null;
  updateGuideLineHighlights();
  refreshAllGuideMarkerOutlines();
  if (selectedGuide) syncInputsFromGuide(selectedGuide);
  refreshGuideList();
}

function refreshGuideList() {
  guideListEl.innerHTML = '';
  layers.forEach((layer) => {
    const layerRow = document.createElement('div');
    layerRow.className = 'layer-row' + (layer.id === activeLayerId ? ' active' : '');
    layerRow.title = 'Click to make this the active layer and select all its guides for bulk editing';

    const chevron = document.createElement('span');
    chevron.className = 'layer-chevron';
    chevron.textContent = layer.collapsed ? '▶' : '▼';
    chevron.title = layer.collapsed ? 'Expand layer' : 'Collapse layer';
    chevron.addEventListener('click', (evt) => {
      evt.stopPropagation(); // don't also trigger the layer-select click below
      layer.collapsed = !layer.collapsed;
      refreshGuideList();
    });

    const label = document.createElement('span');
    label.textContent = layer.name;
    label.style.flex = '1';

    layerRow.append(chevron, label);
    layerRow.addEventListener('click', () => {
      activeLayerId = layer.id;
      selectLayerGuides(layer.id);
    });
    guideListEl.appendChild(layerRow);

    if (layer.collapsed) return; // skip rendering this layer's guides entirely

    const layerGuidesEl = document.createElement('div');
    layerGuidesEl.className = 'layer-guides';
    guides.filter((g) => g.layerId === layer.id).forEach((g) => {
      const row = document.createElement('div');
      row.className = 'guide-item' + (selectedGuideSet.has(g) ? ' selected' : '');
      const swatch = `<span class="swatch" style="background:#${g.color.toString(16).padStart(6, '0')}"></span>`;
      row.innerHTML = `${swatch}Guide ${g.id + 1} — ${g.points.length} pts`;
      row.title = 'Click to select. Ctrl/Cmd+click to add or remove from a multi-selection.';
      row.addEventListener('click', (evt) => {
        if (evt.ctrlKey || evt.metaKey) toggleGuideSelection(g);
        else selectGuide(g);
      });
      layerGuidesEl.appendChild(row);
    });
    guideListEl.appendChild(layerGuidesEl);
  });
  if (selectedGuideSet.size > 1) {
    guideListEl.insertAdjacentHTML('afterbegin', `<div class="micro-note" style="padding:4px 9px;">${selectedGuideSet.size} guides selected — edits below apply to all of them.</div>`);
  }
}

function refreshAtlasDropdown() {
  const current = atlasSliceSelect.value;
  atlasSliceSelect.innerHTML = '<option value="-1">— none (flat gray) —</option>';
  store.regions.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = r.name;
    atlasSliceSelect.appendChild(opt);
  });
  atlasSliceSelect.value = current || '-1';
}
on('regions-changed', refreshAtlasDropdown);

const symmetryCheckbox = document.getElementById('symmetry-mode');

document.getElementById('show-topology').addEventListener('change', (evt) => {
  const visible = evt.target.checked;
  guides.forEach((g) => {
    g.line.visible = visible;
    g.pointsGroup.visible = visible;
  });
});

// Reflects a point across the head's vertical center plane (X = headCenter.x).
function mirrorPoint(p) {
  return new THREE.Vector3(2 * headCenter.x - p.x, p.y, p.z);
}
// Reflects a DIRECTION/delta the same way — only the X component flips.
function mirrorDelta(d) {
  return new THREE.Vector3(-d.x, d.y, d.z);
}

function createNewGuide() {
  pushUndoSnapshot();
  if (selectedGuide) selectedGuide.locked = true;
  const g = makeGuide();
  if (symmetryCheckbox.checked) {
    const mirror = makeGuide();
    mirror.layerId = g.layerId;
    mirror.locked = true; // built entirely by mirroring g — never directly clicked into
    g.mirrorOf = mirror;
    mirror.mirrorOf = g;
  }
  selectGuide(g);
  updateHint();
}

document.getElementById('btn-new-guide').addEventListener('click', createNewGuide);

document.getElementById('btn-add-layer').addEventListener('click', () => {
  pushUndoSnapshot();
  const layer = { id: nextLayerId, name: `Layer ${nextLayerId + 1}` };
  nextLayerId += 1;
  layers.push(layer);
  activeLayerId = layer.id;
  refreshGuideList();
});

lengthSlider.addEventListener('input', () => {
  beginUndoableEdit();
  lengthVal.textContent = Number(lengthSlider.value).toFixed(2);
  guidesToEdit().forEach((g) => {
    g.length = Number(lengthSlider.value);
    refreshGuideLine(g); // live preview of the stretch
  });
});

function deleteSelectedGuides() {
  const targets = guidesToEdit();
  if (targets.length === 0) return;
  pushUndoSnapshot();
  targets.forEach((g) => {
    scene.remove(g.line, g.pointsGroup, g.cardsGroup);
    const idx = guides.indexOf(g);
    if (idx >= 0) guides.splice(idx, 1);
  });
  selectedGuideSet.clear();
  selectGuide(guides[guides.length - 1] || null);
  updateBudgetDashboard();
}
document.getElementById('btn-delete-guide').addEventListener('click', deleteSelectedGuides);

document.getElementById('btn-regen-cards').addEventListener('click', () => {
  const targets = guidesToEdit();
  if (targets.length > 0) {
    pushUndoSnapshot();
    targets.forEach((g) => regenerateCards(g));
  }
  updateBudgetDashboard();
});

// --- Guide Shape Modifiers: deform the actual curve (points), not a texture ---

[
  'mod-bend', 'mod-bend-start', 'mod-curl-amount', 'mod-curl-turns', 'mod-curl-start',
  'mod-guide-noise', 'mod-noise-freq', 'mod-scatter-count', 'mod-scatter-radius',
  'mod-scatter-random', 'mod-clump-amount', 'mod-clump-tip',
].forEach((id) => {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);
  input.addEventListener('input', () => {
    if (id === 'mod-bend') label.textContent = `${input.value}°`;
    else if (id === 'mod-bend-start' || id === 'mod-curl-start') label.textContent = `${input.value}%`;
    else if (id === 'mod-curl-turns' || id === 'mod-noise-freq') label.textContent = Number(input.value).toFixed(1);
    else if (id === 'mod-scatter-count') label.textContent = input.value;
    else label.textContent = Number(input.value).toFixed(id === 'mod-guide-noise' || id === 'mod-scatter-radius' ? 3 : 2);
  });
});

function cumulativeLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i - 1].distanceTo(points[i]));
  return lengths;
}

// Shared per-guide basis: right/normal perpendicular to the strand's overall
// direction, used by Bend/Curl/Noise so they deform sensibly regardless of
// where on the head the guide sits.
function guideDeformBasis(guide) {
  const root = guide.points[0];
  const overallDir = guide.points[guide.points.length - 1].clone().sub(root).normalize();
  const outward = root.clone().sub(headCenter).normalize();
  const right = new THREE.Vector3().crossVectors(overallDir, outward).normalize();
  const normal = new THREE.Vector3().crossVectors(right, overallDir).normalize();
  return { root, overallDir, right, normal };
}

function finishGuideEdit(guide) {
  syncPointMeshes(guide);
  refreshGuideLine(guide);
  computeRestLengths(guide);
  if (guide.cardsGroup.children.length > 0) regenerateCards(guide);
}

document.getElementById('btn-subdivide-guide').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length >= 2);
  if (targets.length === 0) return;
  pushUndoSnapshot();
  targets.forEach((guide) => {
    const curve = new THREE.CatmullRomCurve3(guide.points);
    const newCount = guide.points.length * 2 - 1; // ~doubles resolution, keeps root/tip
    guide.points = curve.getSpacedPoints(newCount - 1);
    finishGuideEdit(guide);
  });
  refreshGuideList();
  updateBudgetDashboard();
});

document.getElementById('btn-unsubdivide-guide').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length > 2);
  if (targets.length === 0) return;
  pushUndoSnapshot();
  targets.forEach((guide) => {
    const curve = new THREE.CatmullRomCurve3(guide.points);
    // Inverse of Subdivide's n -> 2n-1: roughly halves the point count,
    // never going below 2 (a guide needs at least a root and a tip).
    const newCount = Math.max(2, Math.round((guide.points.length + 1) / 2));
    guide.points = curve.getSpacedPoints(newCount - 1);
    finishGuideEdit(guide);
  });
  refreshGuideList();
  updateBudgetDashboard();
});

// --- Bend ---
document.getElementById('btn-apply-bend').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length >= 2);
  const bendDeg = Number(document.getElementById('mod-bend').value);
  if (targets.length === 0 || bendDeg === 0) return;
  pushUndoSnapshot();
  const startFrac = Number(document.getElementById('mod-bend-start').value) / 100;

  targets.forEach((guide) => {
    const { root, right } = guideDeformBasis(guide);
    const lengths = cumulativeLengths(guide.points);
    const total = lengths[lengths.length - 1] || 1;
    for (let i = 1; i < guide.points.length; i++) {
      const t = lengths[i] / total;
      const localT = Math.max(0, (t - startFrac) / Math.max(0.001, 1 - startFrac));
      const angle = THREE.MathUtils.degToRad(bendDeg) * localT;
      const p = guide.points[i].clone().sub(root);
      p.applyAxisAngle(right, angle);
      guide.points[i].copy(root.clone().add(p));
    }
    finishGuideEdit(guide);
  });
  updateBudgetDashboard();
  document.getElementById('mod-bend').value = 0;
  document.getElementById('mod-bend-val').textContent = '0°';
});

// --- Curl ---
document.getElementById('btn-apply-curl').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length >= 2);
  const curlAmount = Number(document.getElementById('mod-curl-amount').value);
  if (targets.length === 0 || curlAmount <= 0) return;
  pushUndoSnapshot();
  const curlTurns = Number(document.getElementById('mod-curl-turns').value);
  const startFrac = Number(document.getElementById('mod-curl-start').value) / 100;

  targets.forEach((guide) => {
    const { right, normal } = guideDeformBasis(guide);
    const lengths = cumulativeLengths(guide.points);
    const total = lengths[lengths.length - 1] || 1;
    for (let i = 1; i < guide.points.length; i++) {
      const t = lengths[i] / total;
      const localT = Math.max(0, (t - startFrac) / Math.max(0.001, 1 - startFrac));
      const theta = localT * curlTurns * Math.PI * 2;
      guide.points[i]
        .addScaledVector(right, Math.cos(theta) * curlAmount * localT)
        .addScaledVector(normal, Math.sin(theta) * curlAmount * localT);
    }
    finishGuideEdit(guide);
  });
  updateBudgetDashboard();
  document.getElementById('mod-curl-amount').value = 0;
  document.getElementById('mod-curl-amount-val').textContent = '0.00';
});

// --- Noise ---
document.getElementById('btn-apply-noise').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length >= 2);
  const noiseAmount = Number(document.getElementById('mod-guide-noise').value);
  if (targets.length === 0 || noiseAmount <= 0) return;
  pushUndoSnapshot();
  const freq = Number(document.getElementById('mod-noise-freq').value);

  targets.forEach((guide) => {
    const { right, normal } = guideDeformBasis(guide);
    const lengths = cumulativeLengths(guide.points);
    const total = lengths[lengths.length - 1] || 1;
    const phase = Math.random() * Math.PI * 2; // per-guide, so a multi-selection doesn't all wave identically
    for (let i = 1; i < guide.points.length; i++) {
      const t = lengths[i] / total;
      const wave = t * freq * Math.PI * 2 + phase;
      guide.points[i]
        .addScaledVector(right, Math.sin(wave) * noiseAmount)
        .addScaledVector(normal, Math.cos(wave * 1.3) * noiseAmount * 0.6);
    }
    finishGuideEdit(guide);
  });
  updateBudgetDashboard();
  document.getElementById('mod-guide-noise').value = 0;
  document.getElementById('mod-guide-noise-val').textContent = '0.000';
});

// --- Scatter: duplicates a guide into a tuft near its root ---
document.getElementById('btn-apply-scatter').addEventListener('click', () => {
  const source = selectedGuide;
  if (!source || source.points.length < 2) return;
  pushUndoSnapshot();

  const count = Number(document.getElementById('mod-scatter-count').value);
  const radius = Number(document.getElementById('mod-scatter-radius').value);
  const randomness = Number(document.getElementById('mod-scatter-random').value);

  const root = source.points[0];
  const outwardDir = root.clone().sub(headCenter).normalize();
  const arbitrary = Math.abs(outwardDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tangentA = new THREE.Vector3().crossVectors(outwardDir, arbitrary).normalize();
  const tangentB = new THREE.Vector3().crossVectors(outwardDir, tangentA).normalize();

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    const offsetRoot = root.clone().addScaledVector(tangentA, Math.cos(angle) * dist).addScaledVector(tangentB, Math.sin(angle) * dist);
    const newOutward = offsetRoot.clone().sub(headCenter).normalize();
    const projectedRoot = headCenter.clone().addScaledVector(newOutward, headSurfaceRadiusAt(newOutward));
    const rootDelta = projectedRoot.clone().sub(root);

    const newGuide = makeGuide();
    newGuide.layerId = source.layerId;
    newGuide.points = source.points.map((p, idx) => {
      const jitter = idx === 0 ? new THREE.Vector3() : new THREE.Vector3(
        (Math.random() - 0.5) * randomness * 0.05,
        (Math.random() - 0.5) * randomness * 0.05,
        (Math.random() - 0.5) * randomness * 0.05
      );
      return p.clone().add(rootDelta).add(jitter);
    });
    newGuide.density = source.density;
    newGuide.cardWidth = source.cardWidth;
    newGuide.spread = source.spread;
    newGuide.taper = source.taper;
    newGuide.atlasRegionIndex = source.atlasRegionIndex;
    newGuide.length = source.length;
    newGuide.locked = true;
    finishGuideEdit(newGuide);
  }
  refreshGuideList();
  updateBudgetDashboard();
});

// --- Clump: pulls every selected guide toward their shared average path ---
document.getElementById('btn-apply-clump').addEventListener('click', () => {
  const targets = guidesToEdit().filter((g) => g.points.length >= 2);
  const amount = Number(document.getElementById('mod-clump-amount').value);
  if (targets.length < 2 || amount <= 0) return;
  pushUndoSnapshot();
  const tipBias = Number(document.getElementById('mod-clump-tip').value);

  const N = 12;
  const resampled = targets.map((g) => new THREE.CatmullRomCurve3(g.points).getSpacedPoints(N - 1));
  const center = [];
  for (let i = 0; i < N; i++) {
    const avg = new THREE.Vector3();
    resampled.forEach((pts) => avg.add(pts[i]));
    avg.divideScalar(resampled.length);
    center.push(avg);
  }

  targets.forEach((guide, gi) => {
    const pts = resampled[gi];
    const newPts = pts.map((p, i) => {
      const t = i / (N - 1);
      const pull = Math.min(1, amount * (1 - tipBias + tipBias * t));
      return p.clone().lerp(center[i], pull);
    });
    newPts[0].copy(pts[0]); // keep the scalp attachment point exactly fixed
    guide.points = newPts;
    finishGuideEdit(guide);
  });
  updateBudgetDashboard();
  document.getElementById('mod-clump-amount').value = 0;
  document.getElementById('mod-clump-amount-val').textContent = '0.00';
});

densitySlider.addEventListener('input', () => {
  beginUndoableEdit();
  densityVal.textContent = densitySlider.value;
  guidesToEdit().forEach((g) => { g.density = Number(densitySlider.value); });
});
cardWidthSlider.addEventListener('input', () => {
  beginUndoableEdit();
  cardWidthVal.textContent = Number(cardWidthSlider.value).toFixed(3);
  guidesToEdit().forEach((g) => { g.cardWidth = Number(cardWidthSlider.value); });
});
spreadSlider.addEventListener('input', () => {
  beginUndoableEdit();
  spreadVal.textContent = Number(spreadSlider.value).toFixed(3);
  guidesToEdit().forEach((g) => { g.spread = Number(spreadSlider.value); });
});
taperToggle.addEventListener('change', () => {
  pushUndoSnapshot();
  guidesToEdit().forEach((g) => { g.taper = taperToggle.checked; });
});
atlasSliceSelect.addEventListener('change', () => {
  pushUndoSnapshot();
  guidesToEdit().forEach((g) => { g.atlasRegionIndex = Number(atlasSliceSelect.value); });
});

// Mode buttons
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeMode = btn.dataset.mode;
    updateHint();
  });
});

const CAMERA_HOTKEY_LINES = ['Right-drag : Orbit.', 'Alt/Ctrl + right-drag : Pan', 'Shift + Right-Drag : Rotate Light.'];

function updateHint() {
  let lines;
  if (activeMode === 'place') {
    lines = ['Place Mode : Click on the head to add guide points.', 'Middle-click (or "New Guide") starts another guide.', ...CAMERA_HOTKEY_LINES];
  } else if (activeMode === 'comb') {
    lines = ['Comb Mode : Left-click-drag near a guide to push its points along the surface.', ...CAMERA_HOTKEY_LINES];
  } else if (activeMode === 'manual') {
    lines = [
      'Manual Edit : click a card, click again for a vertex/edge/face (1/2/3 to switch mode).',
      'G/S/R grab/scale/rotate, then X/Y/Z to constrain an axis — click/Enter confirms, Esc cancels.',
      ...CAMERA_HOTKEY_LINES,
    ];
  } else {
    lines = ['Drag Sim Mode : left-click-drag a guide tip to pull it; enable physics in the right panel to let it settle.', ...CAMERA_HOTKEY_LINES];
  }
  hintEl.innerHTML = lines.join('<br>');
}
updateHint();

// ---------------------------------------------------------------------------
// Auto / Manual card editing mode
// ---------------------------------------------------------------------------

let cardEditMode = 'auto'; // 'auto' | 'manual'
const manualCardPanel = document.getElementById('manual-card-panel');
const manualNoSelection = document.getElementById('manual-no-selection');
const manualSelectedTools = document.getElementById('manual-selected-tools');

document.getElementById('cardmode-auto-btn').addEventListener('click', () => {
  cardEditMode = 'auto';
  document.getElementById('cardmode-auto-btn').classList.add('active');
  document.getElementById('cardmode-manual-btn').classList.remove('active');
  manualCardPanel.classList.add('hidden');
});
document.getElementById('cardmode-manual-btn').addEventListener('click', () => {
  cardEditMode = 'manual';
  document.getElementById('cardmode-manual-btn').classList.add('active');
  document.getElementById('cardmode-auto-btn').classList.remove('active');
  manualCardPanel.classList.remove('hidden');
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    resize();
    if (btn.dataset.tab === 'hair') { updateHairSummary(); resizeSecondaryViewport('hair'); }
    if (btn.dataset.tab === 'render') resizeSecondaryViewport('render');
    if (btn.dataset.tab === 'bakecolors') refreshBakePreview();
  });
});

// Tabs are draggable: drop one onto another to reorder. Tab-key cycling
// always follows whatever order is currently shown, not a fixed list.
const titlebarTabs = document.getElementById('titlebar-tabs');
let draggedTabBtn = null;

titlebarTabs.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('dragstart', () => { draggedTabBtn = btn; btn.classList.add('dragging'); });
  btn.addEventListener('dragend', () => { btn.classList.remove('dragging'); draggedTabBtn = null; });
  btn.addEventListener('dragover', (evt) => { evt.preventDefault(); });
  btn.addEventListener('drop', (evt) => {
    evt.preventDefault();
    if (!draggedTabBtn || draggedTabBtn === btn) return;
    const rect = btn.getBoundingClientRect();
    const insertAfter = evt.clientX - rect.left > rect.width / 2;
    titlebarTabs.insertBefore(draggedTabBtn, insertAfter ? btn.nextSibling : btn);
  });
});

// Tab key cycles through tabs in whatever order they currently appear (left
// to right), wrapping from the last back to the first. Skipped while a form
// field has focus so ordinary tab-to-next-field behavior still works.
window.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Tab') return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  evt.preventDefault();
  const order = Array.from(titlebarTabs.querySelectorAll('.tab-btn')).map((b) => b.dataset.tab);
  const current = document.querySelector('.tab-btn.active');
  const currentTab = current ? current.dataset.tab : 'viewport';
  const next = order[(order.indexOf(currentTab) + 1) % order.length];
  document.querySelector(`.tab-btn[data-tab="${next}"]`).click();
});

function updateHairSummary() {
  let totalCards = 0, totalTris = 0;
  guides.forEach((g) => {
    totalCards += g.cardsGroup.children.length;
    g.cardsGroup.children.forEach((card) => {
      const idx = card.geometry.getIndex();
      totalTris += idx ? idx.count / 3 : 0;
    });
  });
  document.getElementById('hair-stat-layers').textContent = layers.length;
  document.getElementById('hair-stat-guides').textContent = guides.length;
  document.getElementById('hair-stat-cards').textContent = totalCards;
  document.getElementById('hair-stat-tris').textContent = totalTris;
}

// --- Global hair adjustments ---

const hairTintInput = document.getElementById('hair-tint');
hairTintInput.addEventListener('input', () => {
  const seen = new Set();
  guides.forEach((g) => g.cardsGroup.children.forEach((card) => {
    if (seen.has(card.material)) return;
    seen.add(card.material);
    card.material.color.set(hairTintInput.value);
  }));
});

// --- Emissive (with a clickable hue-gradient strip) and Specular/Roughness ---

function forEachUniqueCardMaterial(fn) {
  const seen = new Set();
  guides.forEach((g) => g.cardsGroup.children.forEach((card) => {
    if (seen.has(card.material)) return;
    seen.add(card.material);
    fn(card.material);
  }));
}

const emissiveGradientCanvas = document.getElementById('hair-emissive-gradient');
const emissiveGradientCtx = emissiveGradientCanvas.getContext('2d');
(function drawEmissiveGradient() {
  const grad = emissiveGradientCtx.createLinearGradient(0, 0, emissiveGradientCanvas.width, 0);
  for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${(i / 12) * 360}, 90%, 55%)`);
  emissiveGradientCtx.fillStyle = grad;
  emissiveGradientCtx.fillRect(0, 0, emissiveGradientCanvas.width, emissiveGradientCanvas.height);
})();

const hairEmissiveColorInput = document.getElementById('hair-emissive-color');
const hairEmissiveIntensityInput = document.getElementById('hair-emissive-intensity');

function applyEmissive() {
  const color = hairEmissiveColorInput.value;
  const intensity = Number(hairEmissiveIntensityInput.value);
  forEachUniqueCardMaterial((mat) => {
    mat.emissive.set(color);
    mat.emissiveIntensity = intensity;
  });
}

emissiveGradientCanvas.addEventListener('click', (evt) => {
  const rect = emissiveGradientCanvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const hue = (x / rect.width) * 360;
  const color = new THREE.Color(`hsl(${hue}, 90%, 55%)`);
  hairEmissiveColorInput.value = `#${color.getHexString()}`;
  applyEmissive();
});
hairEmissiveColorInput.addEventListener('input', applyEmissive);
hairEmissiveIntensityInput.addEventListener('input', (evt) => {
  document.getElementById('hair-emissive-intensity-val').textContent = Number(evt.target.value).toFixed(2);
  applyEmissive();
});

const hairRoughnessInput = document.getElementById('hair-roughness');
hairRoughnessInput.addEventListener('input', (evt) => {
  document.getElementById('hair-roughness-val').textContent = Number(evt.target.value).toFixed(2);
  forEachUniqueCardMaterial((mat) => { mat.roughness = Number(evt.target.value); });
});

['hair-density-mult', 'hair-spread-mult'].forEach((id) => {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);
  input.addEventListener('input', () => { label.textContent = Number(input.value).toFixed(2); });
});

document.getElementById('btn-apply-global-hair').addEventListener('click', () => {
  if (guides.length === 0) return;
  pushUndoSnapshot();
  const densityMult = Number(document.getElementById('hair-density-mult').value);
  const spreadMult = Number(document.getElementById('hair-spread-mult').value);
  const taperMode = document.getElementById('hair-taper-override').value;

  guides.forEach((g) => {
    g.density = Math.max(1, Math.round(g.density * densityMult));
    g.spread = g.spread * spreadMult;
    if (taperMode === 'on') g.taper = true;
    if (taperMode === 'off') g.taper = false;
    regenerateCards(g);
  });

  // Multipliers are relative and one-shot — reset back to neutral after applying.
  document.getElementById('hair-density-mult').value = 1;
  document.getElementById('hair-density-mult-val').textContent = '1.00';
  document.getElementById('hair-spread-mult').value = 1;
  document.getElementById('hair-spread-mult-val').textContent = '1.00';

  if (selectedGuide) selectGuide(selectedGuide); // resync sliders in the Selected Guide panel
  updateBudgetDashboard();
  updateHairSummary();
});

// --- Render tab: background, lighting, tone mapping, bloom, stats ---

document.getElementById('render-bg-color').addEventListener('input', (evt) => {
  scene.background = new THREE.Color(evt.target.value);
});

const renderHemiInput = document.getElementById('render-hemi');
renderHemiInput.addEventListener('input', () => {
  document.getElementById('render-hemi-val').textContent = Number(renderHemiInput.value).toFixed(2);
  hemiLight.intensity = Number(renderHemiInput.value);
});
const renderKeyInput = document.getElementById('render-key');
renderKeyInput.addEventListener('input', () => {
  document.getElementById('render-key-val').textContent = Number(renderKeyInput.value).toFixed(2);
  key.intensity = Number(renderKeyInput.value);
});
document.getElementById('render-key-color').addEventListener('input', (evt) => {
  key.color.set(evt.target.value);
});

document.getElementById('render-tonemap-enabled').addEventListener('change', (evt) => {
  const mode = evt.target.checked ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMapping = mode;
  renderPreviewRenderer.toneMapping = mode;
  hairRenderer.toneMapping = mode;
});
const renderExposureInput = document.getElementById('render-exposure');
renderExposureInput.addEventListener('input', () => {
  document.getElementById('render-exposure-val').textContent = Number(renderExposureInput.value).toFixed(2);
  const exposure = Number(renderExposureInput.value);
  renderer.toneMappingExposure = exposure;
  renderPreviewRenderer.toneMappingExposure = exposure;
  hairRenderer.toneMappingExposure = exposure;
});

document.getElementById('render-bloom-enabled').addEventListener('change', (evt) => {
  bloomEnabled = evt.target.checked;
  bloomPass.enabled = bloomEnabled;
  renderPreviewBloomPass.enabled = bloomEnabled;
});
const bloomSliders = [
  ['render-bloom-strength', 'strength'],
  ['render-bloom-radius', 'radius'],
  ['render-bloom-threshold', 'threshold'],
];
bloomSliders.forEach(([id, prop]) => {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);
  input.addEventListener('input', () => {
    label.textContent = Number(input.value).toFixed(2);
    bloomPass[prop] = Number(input.value);
    renderPreviewBloomPass[prop] = Number(input.value);
  });
});

document.getElementById('render-stats-enabled').addEventListener('change', (evt) => {
  document.getElementById('render-stats-overlay').classList.toggle('hidden', !evt.target.checked);
});

// ---------------------------------------------------------------------------
// Pointer interaction: place / comb / drag
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let isPointerDown = false;
let lastHeadHit = null;
let dragTarget = null; // { guide, pointIndex }

const brushRadiusInput = document.getElementById('brush-radius');
const brushRadiusVal = document.getElementById('brush-radius-val');
brushRadiusInput.addEventListener('input', () => {
  brushRadiusVal.textContent = Number(brushRadiusInput.value).toFixed(2);
});

function updateNDC(evt) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
}

function raycastHead() {
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(headMesh);
  return hits.length ? hits[0].point : null;
}

canvas.addEventListener('mousedown', (evt) => {
  if (evt.button === 1) {
    // Middle-click: shortcut for "New Guide", regardless of current mode.
    evt.preventDefault();
    createNewGuide();
    return;
  }
  if (evt.button !== 0) return; // left only; right is reserved for orbit
  updateNDC(evt);
  isPointerDown = true;
  const hit = raycastHead();
  if (!hit) return;
  lastHeadHit = hit.clone();

  if (activeMode === 'place') {
    if (!selectedGuide || selectedGuide.locked) return;
    pushUndoSnapshot();
    selectedGuide.points.push(hit.clone());
    addPointMesh(selectedGuide, hit);
    refreshGuideLine(selectedGuide);
    computeRestLengths(selectedGuide);
    refreshGuideList();

    if (selectedGuide.mirrorOf) {
      const mirror = selectedGuide.mirrorOf;
      mirror.points.push(mirrorPoint(hit));
      syncPointMeshes(mirror);
      refreshGuideLine(mirror);
      computeRestLengths(mirror);
    }
  } else if (activeMode === 'comb' || activeMode === 'drag') {
    if (!selectedGuide) return;
    // Grab nearest point on the selected guide within the brush radius.
    const radius = Number(brushRadiusInput.value);
    let best = -1;
    let bestDist = Infinity;
    selectedGuide.points.forEach((p, i) => {
      const d = p.distanceTo(hit);
      if (d < radius && d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    if (best >= 0) {
      beginUndoableEdit();
      dragTarget = { guide: selectedGuide, pointIndex: best };
    }
  }
});

canvas.addEventListener('mousemove', (evt) => {
  updateNDC(evt);
  if (!isPointerDown) return;
  const hit = raycastHead();
  if (!hit) return;

  if (activeMode === 'comb' && selectedGuide && lastHeadHit) {
    const radius = Number(brushRadiusInput.value);
    const delta = hit.clone().sub(lastHeadHit);
    const mirror = selectedGuide.mirrorOf;
    selectedGuide.points.forEach((p, i) => {
      const d = p.distanceTo(lastHeadHit);
      if (d < radius) {
        const falloff = 1 - d / radius;
        p.addScaledVector(delta, falloff);
        // Re-project lightly toward the head surface so combed points don't
        // drift inside/outside the scalp.
        const dir = p.clone().sub(headCenter).normalize();
        const target = headCenter.clone().addScaledVector(dir, headSurfaceRadiusAt(dir));
        p.lerp(target, 0.15);

        if (mirror && mirror.points[i]) {
          const mp = mirror.points[i];
          mp.addScaledVector(mirrorDelta(delta), falloff);
          const mdir = mp.clone().sub(headCenter).normalize();
          const mtarget = headCenter.clone().addScaledVector(mdir, headSurfaceRadiusAt(mdir));
          mp.lerp(mtarget, 0.15);
        }
      }
    });
    syncPointMeshes(selectedGuide);
    refreshGuideLine(selectedGuide);
    computeRestLengths(selectedGuide);
    repositionAutoCards(selectedGuide);
    if (mirror) {
      syncPointMeshes(mirror);
      refreshGuideLine(mirror);
      computeRestLengths(mirror);
      repositionAutoCards(mirror);
    }
  } else if (activeMode === 'drag' && dragTarget) {
    dragTarget.guide.points[dragTarget.pointIndex].copy(hit);
    syncPointMeshes(dragTarget.guide);
    refreshGuideLine(dragTarget.guide);

    const mirror = dragTarget.guide.mirrorOf;
    if (mirror && mirror.points[dragTarget.pointIndex]) {
      mirror.points[dragTarget.pointIndex].copy(mirrorPoint(hit));
      syncPointMeshes(mirror);
      refreshGuideLine(mirror);
    }
  }

  lastHeadHit = hit.clone();
});

window.addEventListener('mouseup', () => {
  isPointerDown = false;
  dragTarget = null;
  if (manualDragActive && selectedCard) selectedCard.geometry.computeVertexNormals();
  manualDragActive = false;
});

// ---------------------------------------------------------------------------
// Manual card editing: select a card, then a vertex/edge/face on it, and
// drag it around; subdivide to get more rows to work with.
// ---------------------------------------------------------------------------

let selectedCard = null;
let selectedVertIndices = [];
let manualDragActive = false;
let lastDragScreen = null;

let cardHighlight = null; // wireframe outline, child of selectedCard
const vertMarkers = new THREE.Group();
scene.add(vertMarkers);

function allCards() {
  const list = [];
  guides.forEach((g) => list.push(...g.cardsGroup.children));
  return list;
}

function refreshCardHighlight() {
  if (cardHighlight) {
    cardHighlight.geometry.dispose();
    cardHighlight.parent.remove(cardHighlight);
    cardHighlight = null;
  }
  if (!selectedCard) return;
  // WireframeGeometry (not EdgesGeometry) — EdgesGeometry only keeps edges
  // sharper than its angle threshold, so a flat subdivided plane's internal
  // rows (perfectly coplanar, 0° between them) get silently dropped. That
  // was hiding subdivisions even though the geometry genuinely had them.
  const wire = new THREE.WireframeGeometry(selectedCard.geometry);
  cardHighlight = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: 0xf2b84b }));
  cardHighlight.raycast = () => {}; // exclude from raycasting — same reasoning as addCardOutline above
  selectedCard.add(cardHighlight);
}

function refreshVertMarkers() {
  vertMarkers.clear();
  if (!selectedCard) return;

  const selectType = document.getElementById('manual-select-type').value;
  const posAttr = selectedCard.geometry.getAttribute('position');
  const rowCount = selectedCard.userData.segments + 1;
  const selectedSet = new Set(selectedVertIndices);

  function addMarker(localPos, isSelected) {
    const world = selectedCard.localToWorld(localPos.clone());
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(isSelected ? 0.006 : 0.004, 10, 8),
      new THREE.MeshBasicMaterial({ color: isSelected ? 0xf2b84b : 0xcfd2dc })
    );
    marker.position.copy(world);
    vertMarkers.add(marker);
  }

  if (selectType === 'vertex') {
    for (let i = 0; i < posAttr.count; i++) {
      addMarker(new THREE.Vector3().fromBufferAttribute(posAttr, i), selectedSet.has(i));
    }
  } else if (selectType === 'edge') {
    for (let r = 0; r < rowCount; r++) {
      const a = new THREE.Vector3().fromBufferAttribute(posAttr, r * 2);
      const b = new THREE.Vector3().fromBufferAttribute(posAttr, r * 2 + 1);
      const isSelected = selectedSet.has(r * 2) && selectedSet.has(r * 2 + 1);
      addMarker(a.add(b).multiplyScalar(0.5), isSelected);
    }
  } else if (selectType === 'face') {
    for (let r = 0; r < rowCount - 1; r++) {
      const idxs = [r * 2, r * 2 + 1, (r + 1) * 2, (r + 1) * 2 + 1];
      const centroid = new THREE.Vector3();
      idxs.forEach((idx) => centroid.add(new THREE.Vector3().fromBufferAttribute(posAttr, idx)));
      centroid.divideScalar(4);
      addMarker(centroid, idxs.every((idx) => selectedSet.has(idx)));
    }
  }
}

function selectCard(card) {
  selectedCard = card;
  selectedVertIndices = [];
  refreshCardHighlight();
  refreshVertMarkers();
  if (card) {
    manualNoSelection.classList.add('hidden');
    manualSelectedTools.classList.remove('hidden');
    syncTransformInputs();
  } else {
    manualNoSelection.classList.remove('hidden');
    manualSelectedTools.classList.add('hidden');
  }
}

// Grid layout of a PlaneGeometry(width, height, 1, segments): 2 columns,
// (segments+1) rows, row-major, vertex index = row*2 + col.
function pickGridSelection(card, localPoint, selectType) {
  const segments = card.userData.segments;
  const posAttr = card.geometry.getAttribute('position');
  const rowCount = segments + 1;

  // Find the nearest row by comparing localPoint.y against each row's y.
  let bestRow = 0, bestDist = Infinity;
  for (let r = 0; r < rowCount; r++) {
    const y = posAttr.getY(r * 2);
    const d = Math.abs(y - localPoint.y);
    if (d < bestDist) { bestDist = d; bestRow = r; }
  }

  if (selectType === 'vertex') {
    // Nearest of the two vertices in that row by full 3D distance.
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, bestRow * 2);
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, bestRow * 2 + 1);
    return a.distanceTo(localPoint) <= b.distanceTo(localPoint) ? [bestRow * 2] : [bestRow * 2 + 1];
  }
  if (selectType === 'edge') {
    return [bestRow * 2, bestRow * 2 + 1];
  }
  // 'face': the quad cell between bestRow and the next row (clamp at the end)
  const r0 = Math.min(bestRow, rowCount - 2);
  const r1 = r0 + 1;
  return [r0 * 2, r0 * 2 + 1, r1 * 2, r1 * 2 + 1];
}

let cardSweepSelecting = false;

canvas.addEventListener('mousedown', (evt) => {
  if (evt.button !== 0 || activeMode !== 'manual') return;
  updateNDC(evt);
  raycaster.setFromCamera(ndc, camera);

  // If a card is already selected, test it FIRST and exclusively — with
  // tightly packed/overlapping hair cards, a neighboring card was often
  // winning the general hit test, which made the "second click" (meant to
  // pick a vertex/edge/face) re-select a different mesh instead.
  if (selectedCard) {
    const selfHit = raycaster.intersectObject(selectedCard);
    if (selfHit.length > 0) {
      const local = selectedCard.worldToLocal(selfHit[0].point.clone());
      const selectType = document.getElementById('manual-select-type').value;
      selectedVertIndices = pickGridSelection(selectedCard, local, selectType);
      refreshVertMarkers();
      manualDragActive = true;
      lastDragScreen = { x: evt.clientX, y: evt.clientY };
      return;
    }
  }

  const hits = raycaster.intersectObjects(allCards());
  if (hits.length === 0) return;
  selectCard(hits[0].object);
  cardSweepSelecting = true; // keep dragging onto other cards to select each one in turn
});

canvas.addEventListener('mousemove', (evt) => {
  if (!cardSweepSelecting || activeMode !== 'manual') return;
  updateNDC(evt);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(allCards());
  if (hits.length > 0 && hits[0].object !== selectedCard) selectCard(hits[0].object);
});

window.addEventListener('mouseup', () => { cardSweepSelecting = false; });

canvas.addEventListener('mousemove', (evt) => {
  if (activeMode !== 'manual' || !manualDragActive || !selectedCard || selectedVertIndices.length === 0) return;

  const dx = evt.clientX - lastDragScreen.x;
  const dy = evt.clientY - lastDragScreen.y;
  lastDragScreen = { x: evt.clientX, y: evt.clientY };

  // Screen-space drag: move along the camera's own right/up vectors, scaled
  // by distance to the card so it feels consistent whether zoomed in or out.
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  camera.matrixWorld.extractBasis(camRight, camUp, new THREE.Vector3());
  const dist = camera.position.distanceTo(selectedCard.getWorldPosition(new THREE.Vector3()));
  const scale = dist * 0.0015;

  const worldDelta = camRight.multiplyScalar(dx * scale).add(camUp.multiplyScalar(-dy * scale));
  const dragMagnitude = worldDelta.length();
  // transformDirection() always returns a unit vector, so re-apply the
  // original drag distance afterward. Divided by the card's own scale
  // (the visibility boost) since matrixWorld will re-apply that scale when
  // this local-space offset gets transformed back to world space later —
  // without dividing here, dragging would move vertices boost× too far.
  const localDir = worldDelta.clone().normalize().transformDirection(
    new THREE.Matrix4().copy(selectedCard.matrixWorld).invert()
  );
  const localDelta = localDir.multiplyScalar(dragMagnitude / (selectedCard.scale.x || 1));

  const posAttr = selectedCard.geometry.getAttribute('position');
  selectedVertIndices.forEach((idx) => {
    posAttr.setXYZ(idx, posAttr.getX(idx) + localDelta.x, posAttr.getY(idx) + localDelta.y, posAttr.getZ(idx) + localDelta.z);
  });
  posAttr.needsUpdate = true;
  selectedCard.userData.prevLocal = null; // let gravity re-settle from this new shape
  refreshVertMarkers();
  refreshCardHighlight();
});

function rebuildCardGeometry(card, segments) {
  // NOTE: intentionally single-sided PlaneGeometry here, not
  // makeTwoSidedPlaneGeometry — Manual Edit's vertex/edge/face picking and
  // dragging (pickGridSelection, drag handlers) assume simple row*2+col
  // indexing into ONE set of vertices. Baking in a mirrored backface would
  // double the vertex count and silently break that indexing. Instead, this
  // card gets its own cloned material with DoubleSide, so it still looks
  // two-sided — it just won't carry that into OBJ export like Auto-mode
  // cards do (see makeTwoSidedPlaneGeometry's comment).
  const geo = new THREE.PlaneGeometry(card.userData.width, card.userData.height, 1, segments);
  if (card.userData.region) remapUVs(geo, card.userData.region);
  geo.applyMatrix4(card.userData.basisMatrix);
  card.geometry.dispose();
  card.geometry = geo;
  card.userData.segments = segments;
  card.userData.prevLocal = null;
  addCardOutline(card);

  if (!card.userData.hasClonedMaterial) {
    card.material = card.material.clone();
    card.material.side = THREE.DoubleSide;
    card.userData.hasClonedMaterial = true;
  }

  // Whichever end sits closer to the head becomes the pinned root row.
  const posAttr = geo.getAttribute('position');
  const rowCount = segments + 1;
  const rowFirst = card.localToWorld(new THREE.Vector3().fromBufferAttribute(posAttr, 0));
  const rowLast = card.localToWorld(new THREE.Vector3().fromBufferAttribute(posAttr, (rowCount - 1) * 2));
  card.userData.pinnedRow = rowFirst.distanceTo(headCenter) <= rowLast.distanceTo(headCenter) ? 0 : rowCount - 1;
}

document.getElementById('btn-subdivide-card').addEventListener('click', () => {
  if (!selectedCard) return;
  rebuildCardGeometry(selectedCard, selectedCard.userData.segments + 1);
  selectedVertIndices = [];
  refreshCardHighlight();
  refreshVertMarkers();
});

function deleteSelectedCard() {
  if (!selectedCard) return;
  if (transformMode) cancelTransform();
  const guide = selectedCard.userData.guide;
  guide.cardsGroup.remove(selectedCard);
  selectedCard.geometry.dispose();
  if (selectedCard.userData.outline) {
    selectedCard.userData.outline.geometry.dispose();
    selectedCard.userData.outline.material.dispose();
  }
  // Not disposing the card material — it's shared across every other card
  // on this guide (one material per guide, reused), so other cards still need it.
  selectCard(null); // clears highlight/markers and resets the panel to "no selection"
  updateBudgetDashboard();
}
document.getElementById('btn-delete-card').addEventListener('click', deleteSelectedCard);

// --- Position / rotation numeric fields (absolute, in the card's own space) ---

const posInputs = ['card-pos-x', 'card-pos-y', 'card-pos-z'].map((id) => document.getElementById(id));
const rotInputs = ['card-rot-x', 'card-rot-y', 'card-rot-z'].map((id) => document.getElementById(id));

function syncTransformInputs() {
  if (!selectedCard) return;
  posInputs[0].value = selectedCard.position.x.toFixed(4);
  posInputs[1].value = selectedCard.position.y.toFixed(4);
  posInputs[2].value = selectedCard.position.z.toFixed(4);
  rotInputs[0].value = THREE.MathUtils.radToDeg(selectedCard.rotation.x).toFixed(1);
  rotInputs[1].value = THREE.MathUtils.radToDeg(selectedCard.rotation.y).toFixed(1);
  rotInputs[2].value = THREE.MathUtils.radToDeg(selectedCard.rotation.z).toFixed(1);
}

posInputs.forEach((input, axis) => {
  input.addEventListener('input', () => {
    if (!selectedCard) return;
    const key = ['x', 'y', 'z'][axis];
    selectedCard.position[key] = Number(input.value) || 0;
  });
});
rotInputs.forEach((input, axis) => {
  input.addEventListener('input', () => {
    if (!selectedCard) return;
    const key = ['x', 'y', 'z'][axis];
    selectedCard.rotation[key] = THREE.MathUtils.degToRad(Number(input.value) || 0);
  });
});

// ---------------------------------------------------------------------------
// Manual Edit: Blender-style modal Grab (G) / Scale (S) / Rotate (R), with
// X/Y/Z axis constraints and a colored guide line along the active axis.
// Operates on the selected vertex/edge/face if one is picked, otherwise on
// the whole selected card. Left-click or Enter confirms; right-click or
// Escape cancels and reverts. Not covered by Ctrl+Z (same documented
// limitation as the rest of Manual Edit's per-card/per-vertex editing).
// ---------------------------------------------------------------------------

let transformMode = null;      // 'grab' | 'scale' | 'rotate' | null
let transformAxis = null;      // 'x' | 'y' | 'z' | null (null = free/screen-space)
let transformTarget = null;    // 'card' | 'verts'
let transformPivotWorld = null;
let transformStartMouse = { x: 0, y: 0 };
let transformStartPivotScreen = { x: 0, y: 0 };
let transformStartDist = 1;
let transformStartAngle = 0;
let transformOriginalVertLocal = null; // array of THREE.Vector3, parallel to selectedVertIndices
let transformOriginalCardState = null; // { position, rotation, manualScale }
let transformAxisLine = null;
let lastMouseScreen = { x: 0, y: 0 };

function getCardWorldAxis(card, axis) {
  const m = card.matrixWorld.elements;
  const col = axis === 'x' ? [m[0], m[1], m[2]] : axis === 'y' ? [m[4], m[5], m[6]] : [m[8], m[9], m[10]];
  return new THREE.Vector3(col[0], col[1], col[2]).normalize();
}

function localAxisVector(axis) {
  return axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

function worldToScreenPx(worldPos) {
  const v = worldPos.clone().project(camera);
  const rect = canvas.getBoundingClientRect();
  return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
}

function vertexCentroidLocal(points) {
  const c = new THREE.Vector3();
  points.forEach((p) => c.add(p));
  return c.divideScalar(points.length);
}

function startTransform(mode) {
  if (activeMode !== 'manual' || !selectedCard || transformMode) return;
  transformMode = mode;
  transformAxis = null;

  if (selectedVertIndices.length > 0) {
    transformTarget = 'verts';
    const posAttr = selectedCard.geometry.getAttribute('position');
    transformOriginalVertLocal = selectedVertIndices.map((idx) => new THREE.Vector3().fromBufferAttribute(posAttr, idx));
    transformPivotWorld = selectedCard.localToWorld(vertexCentroidLocal(transformOriginalVertLocal).clone());
  } else {
    transformTarget = 'card';
    transformOriginalCardState = {
      position: selectedCard.position.clone(),
      rotation: selectedCard.rotation.clone(),
      manualScale: selectedCard.userData.manualScale || 1,
    };
    transformPivotWorld = selectedCard.getWorldPosition(new THREE.Vector3());
  }

  transformStartMouse = { ...lastMouseScreen };
  transformStartPivotScreen = worldToScreenPx(transformPivotWorld);
  transformStartDist = Math.hypot(transformStartMouse.x - transformStartPivotScreen.x, transformStartMouse.y - transformStartPivotScreen.y) || 1;
  transformStartAngle = Math.atan2(transformStartMouse.y - transformStartPivotScreen.y, transformStartMouse.x - transformStartPivotScreen.x);

  hintEl.textContent = `${mode.toUpperCase()}: move mouse — X/Y/Z to constrain an axis, click/Enter to confirm, Esc/right-click to cancel.`;
}

function applyGrab(worldDelta) {
  if (transformTarget === 'card') {
    selectedCard.position.copy(transformOriginalCardState.position).add(worldDelta);
    return;
  }
  const mag = worldDelta.length();
  const localDir = mag > 0
    ? worldDelta.clone().normalize().transformDirection(new THREE.Matrix4().copy(selectedCard.matrixWorld).invert())
    : new THREE.Vector3();
  const localDelta = localDir.multiplyScalar(mag / (selectedCard.scale.x || 1));
  const posAttr = selectedCard.geometry.getAttribute('position');
  selectedVertIndices.forEach((idx, i) => {
    const orig = transformOriginalVertLocal[i];
    posAttr.setXYZ(idx, orig.x + localDelta.x, orig.y + localDelta.y, orig.z + localDelta.z);
  });
  posAttr.needsUpdate = true;
  refreshVertMarkers();
  refreshCardHighlight();
}

function applyScale(factor) {
  if (transformTarget === 'card') {
    selectedCard.userData.manualScale = (transformOriginalCardState.manualScale || 1) * factor;
    applyCardScale(selectedCard);
    return;
  }
  const centroid = vertexCentroidLocal(transformOriginalVertLocal);
  const posAttr = selectedCard.geometry.getAttribute('position');
  selectedVertIndices.forEach((idx, i) => {
    const rel = transformOriginalVertLocal[i].clone().sub(centroid);
    let scaled;
    if (transformAxis) {
      const axisVec = localAxisVector(transformAxis);
      const along = rel.dot(axisVec);
      const perp = rel.clone().sub(axisVec.clone().multiplyScalar(along));
      scaled = axisVec.clone().multiplyScalar(along * factor).add(perp);
    } else {
      scaled = rel.clone().multiplyScalar(factor);
    }
    const p = centroid.clone().add(scaled);
    posAttr.setXYZ(idx, p.x, p.y, p.z);
  });
  posAttr.needsUpdate = true;
  refreshVertMarkers();
  refreshCardHighlight();
}

function applyRotate(deltaAngle) {
  const axisVec = transformAxis ? localAxisVector(transformAxis) : new THREE.Vector3(0, 0, 1); // default: card's own normal
  if (transformTarget === 'card') {
    selectedCard.rotation.copy(transformOriginalCardState.rotation);
    selectedCard.rotateOnAxis(axisVec, deltaAngle);
    return;
  }
  const centroid = vertexCentroidLocal(transformOriginalVertLocal);
  const posAttr = selectedCard.geometry.getAttribute('position');
  selectedVertIndices.forEach((idx, i) => {
    const rel = transformOriginalVertLocal[i].clone().sub(centroid);
    rel.applyAxisAngle(axisVec, deltaAngle);
    const p = centroid.clone().add(rel);
    posAttr.setXYZ(idx, p.x, p.y, p.z);
  });
  posAttr.needsUpdate = true;
  refreshVertMarkers();
  refreshCardHighlight();
}

function drawAxisGuideLine() {
  if (transformAxisLine) {
    scene.remove(transformAxisLine);
    transformAxisLine.geometry.dispose();
    transformAxisLine = null;
  }
  if (!transformAxis) return;

  const axisWorldDir = transformMode === 'grab' && transformTarget === 'card'
    ? getCardWorldAxis(selectedCard, transformAxis)
    : localAxisVector(transformAxis).transformDirection(selectedCard.matrixWorld).normalize();

  const length = 0.6;
  const p0 = transformPivotWorld.clone().addScaledVector(axisWorldDir, -length);
  const p1 = transformPivotWorld.clone().addScaledVector(axisWorldDir, length);
  const color = transformAxis === 'x' ? 0xff4444 : transformAxis === 'y' ? 0x44ff44 : 0x4488ff;
  const geo = new THREE.BufferGeometry().setFromPoints([p0, p1]);
  transformAxisLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 0.02, gapSize: 0.012 }));
  transformAxisLine.computeLineDistances();
  scene.add(transformAxisLine);
}

function updateTransformPreview() {
  if (!transformMode) return;
  const m = lastMouseScreen;

  if (transformMode === 'grab') {
    const dx = m.x - transformStartMouse.x, dy = m.y - transformStartMouse.y;
    const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
    camera.matrixWorld.extractBasis(camRight, camUp, new THREE.Vector3());
    const dist = camera.position.distanceTo(transformPivotWorld);
    const scale = dist * 0.0015;
    let delta = camRight.multiplyScalar(dx * scale).add(camUp.multiplyScalar(-dy * scale));
    if (transformAxis) {
      const axisDir = transformTarget === 'card' ? getCardWorldAxis(selectedCard, transformAxis)
        : localAxisVector(transformAxis).clone().transformDirection(selectedCard.matrixWorld).normalize();
      delta = axisDir.clone().multiplyScalar(delta.dot(axisDir));
    }
    applyGrab(delta);
  } else if (transformMode === 'scale') {
    const curDist = Math.hypot(m.x - transformStartPivotScreen.x, m.y - transformStartPivotScreen.y) || 1;
    applyScale(curDist / transformStartDist);
  } else if (transformMode === 'rotate') {
    const curAngle = Math.atan2(m.y - transformStartPivotScreen.y, m.x - transformStartPivotScreen.x);
    applyRotate(curAngle - transformStartAngle);
  }
  drawAxisGuideLine();
}

function endTransform() {
  if (transformAxisLine) {
    scene.remove(transformAxisLine);
    transformAxisLine.geometry.dispose();
    transformAxisLine = null;
  }
  transformMode = null;
  transformAxis = null;
  transformTarget = null;
  transformOriginalVertLocal = null;
  transformOriginalCardState = null;
  updateHint();
}

function confirmTransform() {
  if (!transformMode) return;
  endTransform();
}

function cancelTransform() {
  if (!transformMode) return;
  if (transformTarget === 'card' && transformOriginalCardState) {
    selectedCard.position.copy(transformOriginalCardState.position);
    selectedCard.rotation.copy(transformOriginalCardState.rotation);
    selectedCard.userData.manualScale = transformOriginalCardState.manualScale;
    applyCardScale(selectedCard);
  } else if (transformTarget === 'verts' && transformOriginalVertLocal) {
    const posAttr = selectedCard.geometry.getAttribute('position');
    selectedVertIndices.forEach((idx, i) => {
      const orig = transformOriginalVertLocal[i];
      posAttr.setXYZ(idx, orig.x, orig.y, orig.z);
    });
    posAttr.needsUpdate = true;
    refreshVertMarkers();
    refreshCardHighlight();
  }
  endTransform();
}

canvas.addEventListener('mousemove', (evt) => {
  const rect = canvas.getBoundingClientRect();
  lastMouseScreen = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  if (transformMode) updateTransformPreview();
});

// Capture phase so this always runs before the existing select/orbit
// mousedown handlers on the same canvas, and stops them from also firing.
canvas.addEventListener('mousedown', (evt) => {
  if (!transformMode) return;
  evt.preventDefault();
  evt.stopImmediatePropagation();
  if (evt.button === 0) confirmTransform();
  else if (evt.button === 2) cancelTransform();
}, true);

// Safety net: a transform can only be confirmed/canceled by a click ON the
// canvas (above) or a keypress. If the user instead clicks a side-panel
// button (Delete This Card, Subdivide, a mode toggle, etc.) while a
// transform is mid-drag, nothing would otherwise clear transformMode — and
// a stuck transformMode makes the capture-phase handler above swallow every
// future canvas click via stopImmediatePropagation, which looks exactly
// like "card selection stopped working."
window.addEventListener('mousedown', (evt) => {
  if (transformMode && evt.target !== canvas) cancelTransform();
});

window.addEventListener('keydown', (evt) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const activeTabBtn = document.querySelector('.tab-btn.active');
  if (!activeTabBtn || activeTabBtn.dataset.tab !== 'viewport') return;

  const key = evt.key.toLowerCase();

  if (transformMode) {
    if (key === 'x' || key === 'y' || key === 'z') {
      transformAxis = transformAxis === key ? null : key; // pressing the same axis again returns to free movement
      updateTransformPreview();
      evt.preventDefault();
      return;
    }
    if (evt.key === 'Enter') { confirmTransform(); evt.preventDefault(); }
    else if (evt.key === 'Escape') { cancelTransform(); evt.preventDefault(); }
    return; // swallow everything else while a transform is active
  }

  if (activeMode !== 'manual' || !selectedCard) return;
  if (key === 'g') { startTransform('grab'); evt.preventDefault(); }
  else if (key === 's') { startTransform('scale'); evt.preventDefault(); }
  else if (key === 'r') { startTransform('rotate'); evt.preventDefault(); }
  else if (key === '1' || key === '2' || key === '3') {
    const mode = { 1: 'vertex', 2: 'edge', 3: 'face' }[key];
    document.getElementById('manual-select-type').value = mode;
    selectedVertIndices = [];
    refreshVertMarkers();
    evt.preventDefault();
  }
});

document.getElementById('manual-select-type').addEventListener('change', () => {
  selectedVertIndices = [];
  refreshVertMarkers();
});

const headSurfaceRaycaster = new THREE.Raycaster();
function headSurfaceRadiusAt(dir) {
  // Cast from the head's center outward along `dir` and measure the actual
  // distance to the mesh surface — works for the ellipsoid fallback and for
  // any imported head shape alike, unlike a fixed analytic formula.
  headSurfaceRaycaster.set(headCenter, dir);
  const hits = headSurfaceRaycaster.intersectObject(headMesh);
  return hits.length ? hits[0].distance : HEAD_RADIUS;
}

// ---------------------------------------------------------------------------
// Verlet physics for Drag Sim mode
// ---------------------------------------------------------------------------

const physicsEnabled = document.getElementById('physics-enabled');
const gravityInput = document.getElementById('gravity');
const stiffnessInput = document.getElementById('stiffness');
const dampingInput = document.getElementById('damping');
[gravityInput, stiffnessInput, dampingInput].forEach((el, i) => {
  const labelEls = ['gravity-val', 'stiffness-val', 'damping-val'];
  el.addEventListener('input', () => {
    document.getElementById(labelEls[i]).textContent = Number(el.value).toFixed(2);
  });
});

// Spacebar toggles live simulation, unless a text/number/select field is
// focused (so it doesn't fight with normal typing or slider dragging).
window.addEventListener('keydown', (evt) => {
  if (evt.code !== 'Space') return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  evt.preventDefault();
  physicsEnabled.checked = !physicsEnabled.checked;
  hintEl.textContent = physicsEnabled.checked
    ? 'Live simulation ON — press Space to pause.'
    : 'Live simulation OFF — press Space to resume.';
});

function stepPhysics(dt) {
  const gravity = Number(gravityInput.value);
  const damping = Number(dampingInput.value);
  const stiffness = Number(stiffnessInput.value);

  if (physicsEnabled.checked) {
  guides.forEach((guide) => {
    const pts = guide.points;
    if (pts.length < 2) return;
    if (guide.prevPoints.length !== pts.length) {
      guide.prevPoints = pts.map((p) => p.clone());
    }

    const isBeingDragged = dragTarget && dragTarget.guide === guide;

    // Verlet integration (skip index 0: pinned root at the scalp).
    for (let i = 1; i < pts.length; i++) {
      if (isBeingDragged && i === dragTarget.pointIndex) continue; // pinned to cursor
      const current = pts[i].clone();
      const prev = guide.prevPoints[i];
      const velocity = current.clone().sub(prev).multiplyScalar(damping);
      const next = current.clone().add(velocity);
      next.y -= gravity * dt * dt;
      guide.prevPoints[i] = current;
      pts[i].copy(next);
    }

    // Distance constraints to stop the strand stretching into a mess.
    if (guide.restLengths.length !== pts.length - 1) computeRestLengths(guide);
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const restLen = guide.restLengths[i - 1] || 0.05;
        const diff = b.clone().sub(a);
        const dist = diff.length() || 0.0001;
        const correction = diff.multiplyScalar(((dist - restLen) / dist) * stiffness * 0.5);
        if (i - 1 !== 0) a.add(correction);
        if (!(isBeingDragged && i === dragTarget.pointIndex)) b.sub(correction);
      }
    }

    // Head collision: push points back outside the scalp ellipsoid.
    for (let i = 1; i < pts.length; i++) {
      const dir = pts[i].clone().sub(headCenter);
      const dist = dir.length();
      const surf = headSurfaceRadiusAt(dir.clone().normalize());
      if (dist < surf) {
        pts[i].copy(headCenter.clone().addScaledVector(dir.normalize(), surf));
      }
    }

    syncPointMeshes(guide);
    refreshGuideLine(guide);
    repositionAutoCards(guide);
  });
  } // end physicsEnabled.checked

  const manualGravityEl = document.getElementById('manual-gravity-enabled');
  if (manualGravityEl && manualGravityEl.checked) {
    allCards().forEach((card) => {
      if (card.userData.segments < 2) return; // only subdivided cards have rows to sag
      const posAttr = card.geometry.getAttribute('position');
      const rowCount = card.userData.segments + 1;
      const pinnedRow = card.userData.pinnedRow;

      if (!card.userData.prevLocal || card.userData.prevLocal.length !== posAttr.count) {
        card.userData.prevLocal = [];
        for (let i = 0; i < posAttr.count; i++) card.userData.prevLocal.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));
      }

      // Gravity direction expressed in the card's own local space (handles
      // cards that have been rotated via the manual XYZ rotation fields).
      const localDown = new THREE.Vector3(0, -1, 0).transformDirection(
        new THREE.Matrix4().copy(card.matrixWorld).invert()
      ).normalize();

      const current = [];
      for (let i = 0; i < posAttr.count; i++) current.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));

      for (let r = 0; r < rowCount; r++) {
        if (r === pinnedRow) continue;
        for (const col of [0, 1]) {
          const idx = r * 2 + col;
          const cur = current[idx].clone();
          const prev = card.userData.prevLocal[idx];
          const vel = cur.clone().sub(prev).multiplyScalar(damping);
          const next = cur.clone().add(vel).addScaledVector(localDown, gravity * dt * dt);
          card.userData.prevLocal[idx] = cur;
          current[idx] = next;
        }
      }

      // Keep each column's row-to-row spacing from stretching.
      for (let iter = 0; iter < 3; iter++) {
        for (let r = 0; r < rowCount - 1; r++) {
          for (const col of [0, 1]) {
            const a = current[r * 2 + col];
            const b = current[(r + 1) * 2 + col];
            const diff = b.clone().sub(a);
            const dist = diff.length() || 0.0001;
            const correction = diff.multiplyScalar(((dist - (card.userData.height / (rowCount - 1))) / dist) * stiffness * 0.5);
            if (r !== pinnedRow) a.add(correction);
            if (r + 1 !== pinnedRow) b.sub(correction);
          }
        }
      }

      current.forEach((v, i) => posAttr.setXYZ(i, v.x, v.y, v.z));
      posAttr.needsUpdate = true;
    });
  }
}

// ---------------------------------------------------------------------------
// OBJ export
// ---------------------------------------------------------------------------

// Builds the OBJ text for all current cards. Shared by the plain-OBJ export
// and the OBJ+MTL export. `usemtl` lines are only included when withMaterials
// is true, grouped by guide (since each guide has its own material/texture).
// Shared by the FBX and USD exporters: walks every card's real (unboosted)
// geometry once and returns flat position/uv arrays plus a reconstructed
// quad list (4 global vertex indices each) — the same quad-from-two-triangles
// reconstruction used for OBJ export, extracted here so it's not duplicated
// a third time.
function gatherMeshQuadData() {
  const allCardMeshes = [];
  guides.forEach((g) => g.cardsGroup.children.forEach((c) => allCardMeshes.push(c)));
  allCardMeshes.forEach((c) => { c.scale.setScalar(c.userData.manualScale || 1); c.updateMatrixWorld(true); });

  const positions = [];
  const uvs = [];
  const quads = [];
  let vOffset = 0;

  guides.forEach((guide) => {
    guide.cardsGroup.children.forEach((card) => {
      card.updateMatrixWorld(true);
      const posAttr = card.geometry.getAttribute('position');
      const uvAttr = card.geometry.getAttribute('uv');
      const index = card.geometry.getIndex();
      const v = new THREE.Vector3();

      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(card.matrixWorld);
        positions.push(v.x, v.y, v.z);
        uvs.push(uvAttr.getX(i), uvAttr.getY(i));
      }
      for (let f = 0; f < index.count; f += 6) {
        const tri1 = [index.getX(f), index.getX(f + 1), index.getX(f + 2)];
        const tri2 = [index.getX(f + 3), index.getX(f + 4), index.getX(f + 5)];
        const set1 = new Set(tri1);
        const shared = tri2.filter((x) => set1.has(x));
        const uniq2 = tri2.find((x) => !set1.has(x));
        const uniq1 = tri1.find((x) => !shared.includes(x));
        if (shared.length === 2 && uniq1 !== undefined && uniq2 !== undefined) {
          const [p, q] = shared;
          quads.push([uniq1, p, uniq2, q].map((idx) => idx + vOffset));
        }
      }
      vOffset += posAttr.count;
    });
  });

  allCardMeshes.forEach((c) => { applyCardScale(c); c.updateMatrixWorld(true); });
  return { positions, uvs, quads, vertCount: vOffset };
}

// --- FBX (legacy ASCII variant) ---
// No official open-source FBX writer exists for JavaScript (Autodesk's
// format is proprietary; Three.js itself only ships an FBX *importer* for
// this reason). This targets FBX 7.4's documented ASCII text structure,
// which many DCC/engine importers do accept — but unlike glTF/OBJ, I have
// no way to validate it against real target software, so treat this as a
// best-effort option, not a guaranteed-solid one.
function buildFBXAscii({ positions, uvs, quads }) {
  const posStr = positions.map((n) => n.toFixed(6)).join(',');
  const uvStr = uvs.map((n) => n.toFixed(6)).join(',');

  const polyIdx = [];
  const uvIndex = [];
  const normals = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  quads.forEach((q) => {
    polyIdx.push(q[0], q[1], q[2], -(q[3] + 1)); // FBX marks a polygon's last index as -(index+1)
    uvIndex.push(q[0], q[1], q[2], q[3]);
    a.set(positions[q[0] * 3], positions[q[0] * 3 + 1], positions[q[0] * 3 + 2]);
    b.set(positions[q[1] * 3], positions[q[1] * 3 + 1], positions[q[1] * 3 + 2]);
    c.set(positions[q[2] * 3], positions[q[2] * 3 + 1], positions[q[2] * 3 + 2]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (let k = 0; k < 4; k++) normals.push(n.x, n.y, n.z);
  });

  return `; FBX 7.4.0 project file
; GeoStrands export — legacy ASCII FBX (best-effort; see Export tab note)

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "GeoStrands"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",100
\t}
}
Objects:  {
\tGeometry: 1000000000, "Geometry::hair_cards", "Mesh" {
\t\tVertices: *${positions.length} {
\t\t\ta: ${posStr}
\t\t}
\t\tPolygonVertexIndex: *${polyIdx.length} {
\t\t\ta: ${polyIdx.join(',')}
\t\t}
\t\tLayerElementNormal: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
\t\t\tNormals: *${normals.length} {
\t\t\t\ta: ${normals.map((n) => n.toFixed(6)).join(',')}
\t\t\t}
\t\t}
\t\tLayerElementUV: 0 {
\t\t\tVersion: 101
\t\t\tName: "UVMap"
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tUV: *${uvs.length} {
\t\t\t\ta: ${uvStr}
\t\t\t}
\t\t\tUVIndex: *${uvIndex.length} {
\t\t\t\ta: ${uvIndex.join(',')}
\t\t\t}
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: *1 {
\t\t\t\ta: 0
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementNormal"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementUV"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t}
\t}
\tModel: 2000000000, "Model::hair_cards", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
\tMaterial: 3000000000, "Material::hair_material", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",1,1,1
\t\t}
\t}
}
Connections:  {
\tC: "OO",1000000000,2000000000
\tC: "OO",3000000000,2000000000
}
`;
}

// --- USD (USDA text variant) ---
function buildUSDAMesh({ positions, uvs, quads }, textureFileName) {
  const faceVertexCounts = quads.map(() => 4).join(', ');
  const faceVertexIndices = quads.map((q) => q.join(', ')).join(', ');
  const pointsStr = [];
  for (let i = 0; i < positions.length; i += 3) {
    pointsStr.push(`(${positions[i].toFixed(6)}, ${positions[i + 1].toFixed(6)}, ${positions[i + 2].toFixed(6)})`);
  }
  const stStr = [];
  quads.forEach((q) => q.forEach((idx) => stStr.push(`(${uvs[idx * 2].toFixed(6)}, ${uvs[idx * 2 + 1].toFixed(6)})`)));

  const materialBlock = textureFileName ? `
    def Scope "Materials"
    {
        def Material "HairMaterial"
        {
            token outputs:surface.connect = </hair_cards/Materials/HairMaterial/PreviewSurface.outputs:surface>
            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </hair_cards/Materials/HairMaterial/DiffuseTexture.outputs:rgb>
                float inputs:opacity.connect = </hair_cards/Materials/HairMaterial/DiffuseTexture.outputs:a>
                token outputs:surface
            }
            def Shader "DiffuseTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @${textureFileName}@
                float2 inputs:st.connect = </hair_cards/Materials/HairMaterial/stReader.outputs:result>
                float3 outputs:rgb
                float outputs:a
            }
            def Shader "stReader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st"
                float2 outputs:result
            }
        }
    }` : '';

  return `#usda 1.0
(
    defaultPrim = "hair_cards"
    upAxis = "Y"
)

def Xform "hair_cards"
{
    def Mesh "cards"
    {
        int[] faceVertexCounts = [${faceVertexCounts}]
        int[] faceVertexIndices = [${faceVertexIndices}]
        point3f[] points = [${pointsStr.join(', ')}]
        texCoord2f[] primvars:st = [${stStr.join(', ')}] (
            interpolation = "faceVarying"
        )
        ${textureFileName ? 'rel material:binding = </hair_cards/Materials/HairMaterial>' : ''}
    }
${materialBlock}
}
`;
}

// Guide curves as USD BasisCurves — the real, standards-based path toward a
// "Groom"-like workflow: this is genuine strand data (unlike the card mesh),
// importable by USD-aware DCC tools and engines as actual curve geometry.
function buildUSDACurves() {
  const activeGuides = guides.filter((g) => g.points.length >= 2);
  const curveVertexCounts = activeGuides.map((g) => g.points.length).join(', ');
  const pointsStr = [];
  activeGuides.forEach((g) => g.points.forEach((p) => pointsStr.push(`(${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)})`)));

  return `#usda 1.0
(
    defaultPrim = "hair_guides"
    upAxis = "Y"
)

def BasisCurves "hair_guides"
{
    uniform token type = "linear"
    uniform token wrap = "nonperiodic"
    int[] curveVertexCounts = [${curveVertexCounts}]
    point3f[] points = [${pointsStr.join(', ')}]
}
`;
}

function buildOBJText(withMaterials) {
  const allCardMeshes = [];
  guides.forEach((g) => g.cardsGroup.children.forEach((c) => allCardMeshes.push(c)));
  allCardMeshes.forEach((c) => { c.scale.setScalar(c.userData.manualScale || 1); c.updateMatrixWorld(true); });

  let vOffset = 0;
  let quadCount = 0;
  const lines = ['# GeoStrands export', '# Quad-topology mesh (each face below is a real 4-vertex quad, not a triangle pair)'];
  if (withMaterials) lines.push('mtllib hair-cards.mtl');
  lines.push('o hair_cards');

  guides.forEach((guide, guideIdx) => {
    if (guide.cardsGroup.children.length === 0) return;
    if (withMaterials) lines.push(`usemtl guide_${guideIdx}`);
    guide.cardsGroup.children.forEach((card) => {
      card.updateMatrixWorld(true);
      const posAttr = card.geometry.getAttribute('position');
      const uvAttr = card.geometry.getAttribute('uv');
      const index = card.geometry.getIndex();
      const v = new THREE.Vector3();

      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(card.matrixWorld);
        lines.push(`v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}`);
        lines.push(`vt ${uvAttr.getX(i).toFixed(6)} ${uvAttr.getY(i).toFixed(6)}`);
      }

      // Our geometry is always built from plane grids, so every 6 consecutive
      // indices are exactly two triangles sharing one diagonal edge — i.e.
      // one quad cell. Reconstruct that quad's perimeter by finding the
      // shared edge (the diagonal) vs. each triangle's one unique corner.
      // This works regardless of winding direction, which matters here since
      // the two-sided geometry's back faces have deliberately reversed
      // winding (see makeTwoSidedPlaneGeometry).
      for (let f = 0; f < index.count; f += 6) {
        const tri1 = [index.getX(f), index.getX(f + 1), index.getX(f + 2)];
        const tri2 = [index.getX(f + 3), index.getX(f + 4), index.getX(f + 5)];
        const set1 = new Set(tri1);
        const shared = tri2.filter((x) => set1.has(x));
        const uniq2 = tri2.find((x) => !set1.has(x));
        const uniq1 = tri1.find((x) => !shared.includes(x));

        if (shared.length === 2 && uniq1 !== undefined && uniq2 !== undefined) {
          const [p, q] = shared;
          const quad = [uniq1, p, uniq2, q].map((idx) => idx + 1 + vOffset);
          lines.push(`f ${quad.map((n) => `${n}/${n}`).join(' ')}`);
          quadCount++;
        } else {
          const a = tri1[0] + 1 + vOffset, b = tri1[1] + 1 + vOffset, c = tri1[2] + 1 + vOffset;
          const d = tri2[0] + 1 + vOffset, e = tri2[1] + 1 + vOffset, fv = tri2[2] + 1 + vOffset;
          lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
          lines.push(`f ${d}/${d} ${e}/${e} ${fv}/${fv}`);
        }
      }
      vOffset += posAttr.count;
    });
  });

  allCardMeshes.forEach((c) => { applyCardScale(c); c.updateMatrixWorld(true); }); // restore visibility boost
  return { objText: lines.join('\n'), quadCount, vertCount: vOffset };
}

function buildMTLText() {
  const lines = [];
  guides.forEach((guide, guideIdx) => {
    if (guide.cardsGroup.children.length === 0) return;
    lines.push(`newmtl guide_${guideIdx}`);
    lines.push('illum 2');
    lines.push('Kd 1.000 1.000 1.000');
    if (store.atlasImage) {
      lines.push('map_Kd hair-cards_albedo.png');
      lines.push('map_d hair-cards_albedo.png'); // alpha channel for card cutout transparency
    }
    lines.push('');
  });
  return lines.join('\n');
}

document.getElementById('btn-export-obj-plain').addEventListener('click', () => {
  document.getElementById('btn-export-obj').click();
});

document.getElementById('btn-export-obj').addEventListener('click', async () => {
  const { objText, vertCount, quadCount } = buildOBJText(false);
  if (vertCount === 0) {
    alert('Nothing to export yet — generate some cards first.');
    return;
  }
  const savedPath = await window.hcsAPI.exportOBJ(objText);
  if (savedPath) hintEl.textContent = `Exported: ${savedPath} (${quadCount} quads)`;
});

document.getElementById('btn-export-obj-mtl').addEventListener('click', async () => {
  const { objText, vertCount, quadCount } = buildOBJText(true);
  if (vertCount === 0) {
    alert('Nothing to export yet — generate some cards first.');
    return;
  }
  const mtlText = buildMTLText();
  const textureBase64 = store.atlasImage ? getCompositeTextureBase64() : null;
  const result = await window.hcsAPI.exportOBJWithMTL(objText, mtlText, textureBase64);
  if (result) hintEl.textContent = `Exported: ${result.objPath} + .mtl${result.texturePath ? ' + texture' : ''} (${quadCount} quads)`;
});

// Extracts the atlas texture as a base64 PNG for embedding/referencing in
// exports — reads directly from the source image, not the live GPU texture.
function getCompositeTextureBase64() {
  if (!store.atlasImage) return null;
  const canvas = document.createElement('canvas');
  canvas.width = store.atlasImage.width;
  canvas.height = store.atlasImage.height;
  canvas.getContext('2d').drawImage(store.atlasImage, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

document.getElementById('btn-export-gltf').addEventListener('click', () => {
  const allCardMeshes = [];
  guides.forEach((g) => g.cardsGroup.children.forEach((c) => allCardMeshes.push(c)));
  if (allCardMeshes.length === 0) {
    alert('Nothing to export yet — generate some cards first.');
    return;
  }

  // Export clones into a throwaway group — never touch the live scene, so
  // there's no risk of a visible glitch or a half-modified state if the
  // (partly async) exporter takes a moment.
  const exportGroup = new THREE.Group();
  allCardMeshes.forEach((c) => {
    const clone = new THREE.Mesh(c.geometry, c.material);
    clone.position.copy(c.position);
    clone.quaternion.copy(c.quaternion);
    clone.scale.setScalar(c.userData.manualScale || 1); // real size, not the visibility boost
    exportGroup.add(clone);
  });

  new GLTFExporter().parse(
    exportGroup,
    async (result) => {
      const bytes = new Uint8Array(result);
      let binaryStr = '';
      for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
      const base64 = btoa(binaryStr);
      const savedPath = await window.hcsAPI.exportGLB(base64);
      if (savedPath) hintEl.textContent = `Exported: ${savedPath}`;
    },
    (err) => {
      console.error('glTF export failed:', err);
      alert('glTF export failed — see the console for details.');
    },
    { binary: true }
  );
});

document.getElementById('btn-export-fbx').addEventListener('click', async () => {
  const meshData = gatherMeshQuadData();
  if (meshData.vertCount === 0) {
    alert('Nothing to export yet — generate some cards first.');
    return;
  }
  const fbxText = buildFBXAscii(meshData);
  const savedPath = await window.hcsAPI.exportText('Export FBX (ASCII)', 'hair-cards.fbx', 'FBX (ASCII)', ['fbx'], fbxText);
  if (savedPath) hintEl.textContent = `Exported: ${savedPath} (experimental ASCII FBX)`;
});

document.getElementById('btn-export-usd').addEventListener('click', async () => {
  const meshData = gatherMeshQuadData();
  if (meshData.vertCount === 0) {
    alert('Nothing to export yet — generate some cards first.');
    return;
  }
  const usdaText = buildUSDAMesh(meshData, store.atlasImage ? 'hair-cards_albedo.png' : null);
  const savedPath = await window.hcsAPI.exportText('Export USD (.usda)', 'hair-cards.usda', 'USD ASCII', ['usda'], usdaText);
  if (!savedPath) return;
  if (store.atlasImage) {
    // Write the referenced texture alongside, matching the @filename@ reference above.
    const dir = savedPath.substring(0, savedPath.lastIndexOf(savedPath.includes('\\') ? '\\' : '/') + 1);
    const files = [{ filename: 'hair-cards_albedo.png', dataURL: `data:image/png;base64,${getCompositeTextureBase64()}` }];
    await window.hcsAPI.writeExportFiles(dir, files);
  }
  hintEl.textContent = `Exported: ${savedPath} (experimental USDA)`;
});

document.getElementById('btn-export-usd-curves').addEventListener('click', async () => {
  if (guides.filter((g) => g.points.length >= 2).length === 0) {
    alert('Nothing to export yet — place at least one guide with 2+ points.');
    return;
  }
  const usdaText = buildUSDACurves();
  const savedPath = await window.hcsAPI.exportText('Export Guide Curves (.usda)', 'hair-guides.usda', 'USD ASCII', ['usda'], usdaText);
  if (savedPath) hintEl.textContent = `Exported: ${savedPath} (real guide curve data, experimental USDA)`;
});

// ---------------------------------------------------------------------------
// Project save / load
// ---------------------------------------------------------------------------

function buildProjectJSON() {
  const project = {
    layers,
    activeLayerId,
    guides: guides.map((g) => ({
      layerId: g.layerId,
      length: g.length,
      points: g.points.map((p) => [p.x, p.y, p.z]),
      density: g.density,
      cardWidth: g.cardWidth,
      spread: g.spread,
      taper: g.taper,
      atlasRegionIndex: g.atlasRegionIndex,
    })),
    atlas: store.atlasImageURL
      ? { imageURL: store.atlasImageURL, fileName: store.atlasFileName, regions: store.regions }
      : null,
  };
  return JSON.stringify(project);
}

// --- Autosave: periodic, silent, and deliberately NEVER touches the file
// the user manually chose via Save Project — it always writes to its own
// dedicated location (browser storage, see platform-web.js), so it can never
// clobber a deliberate save with in-progress/experimental work.
let autosaveTimer = null;

async function performAutosave() {
  if (guides.length === 0) return; // nothing worth saving yet
  try {
    const savedPath = await window.hcsAPI.autosaveWrite(null, buildProjectJSON());
    hintEl.textContent = `Autosaved (${new Date().toLocaleTimeString()}) — ${savedPath}`;
  } catch (err) {
    console.warn('Autosave failed:', err);
  }
}

function restartAutosaveTimer() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = null;
  if (!getAutosaveEnabled()) return;
  const intervalMs = getAutosaveIntervalMin() * 60 * 1000;
  autosaveTimer = setInterval(performAutosave, intervalMs);
}

window.addEventListener('autosave-settings-changed', restartAutosaveTimer);
restartAutosaveTimer();

document.getElementById('btn-save-project').addEventListener('click', async () => {
  const savedPath = await window.hcsAPI.saveProject(buildProjectJSON());
  if (savedPath) {
    lastProjectFilePath = savedPath;
    hintEl.textContent = `Saved: ${savedPath}`;
  }
});

let lastProjectFilePath = null; // tracked for Ctrl+S / autosave to know where to write silently

function loadProjectFromJSON(jsonString, filePath) {
  const project = JSON.parse(jsonString);

  guides.slice().forEach((g) => scene.remove(g.line, g.pointsGroup, g.cardsGroup));
  guides.length = 0;
  guideCounter = 0;

  layers.length = 0;
  if (project.layers && project.layers.length) {
    layers.push(...project.layers);
    nextLayerId = Math.max(...layers.map((l) => l.id)) + 1;
  } else {
    layers.push({ id: 0, name: 'Layer 1' });
    nextLayerId = 1;
  }
  activeLayerId = project.activeLayerId ?? layers[0].id;

  if (project.atlas) restoreAtlasFromProject(project.atlas);

  project.guides.forEach((gd) => {
    const guide = makeGuide();
    guide.layerId = gd.layerId ?? layers[0].id;
    guide.length = gd.length ?? 1.0;
    guide.points = gd.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    guide.density = gd.density;
    guide.cardWidth = gd.cardWidth;
    guide.spread = gd.spread;
    guide.taper = gd.taper;
    guide.atlasRegionIndex = gd.atlasRegionIndex;
    guide.locked = true;
    syncPointMeshes(guide);
    refreshGuideLine(guide);
    computeRestLengths(guide);
    regenerateCards(guide);
  });
  selectGuide(guides[guides.length - 1] || null);
  updateBudgetDashboard();
  if (filePath) lastProjectFilePath = filePath;
}

document.getElementById('btn-open-project').addEventListener('click', async () => {
  const result = await window.hcsAPI.openProject();
  if (!result) return;
  loadProjectFromJSON(result.content, result.filePath);
  hintEl.textContent = `Opened: ${result.filePath}`;
});

if (window.hcsAPI.onMenuOpenRecentFile) {
  window.hcsAPI.onMenuOpenRecentFile((_evt, { filePath, content }) => {
    loadProjectFromJSON(content, filePath);
    hintEl.textContent = `Opened: ${filePath}`;
  });
}
if (window.hcsAPI.onMenuRecentFileMissing) {
  window.hcsAPI.onMenuRecentFileMissing((_evt, filePath) => {
    hintEl.textContent = `Couldn't find ${filePath} — it may have been moved or deleted.`;
  });
}

// Atlas image/regions changing affects the texture-memory estimate even if
// card count doesn't change.
on('regions-changed', () => updateBudgetDashboard());
on('atlas-image-changed', () => updateBudgetDashboard());

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastTime = performance.now();
let fpsSmoothed = 0;
function animate(now) {
  const dt = Math.min(0.033, (now - lastTime) / 1000);
  lastTime = now;
  stepPhysics(dt);
  controls.update();
  try {
    if (bloomEnabled || aoEnabled) composer.render(); else renderer.render(scene, camera);
  } catch (err) {
    console.warn('Main viewport render failed:', err);
  }

  const activeTabBtn = document.querySelector('.tab-btn.active');
  const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'viewport';
  if (activeTab === 'hair' || activeTab === 'render') {
    const which = activeTab;
    const r = which === 'hair' ? hairRenderer : renderPreviewRenderer;
    const previewCamera = which === 'hair' ? hairPreviewCamera : renderPreviewCamera;
    const previewControls = which === 'hair' ? hairPreviewControls : renderPreviewControls;
    try {
      resizeSecondaryViewport(which);
      const wrap = document.getElementById(`${which}-viewport-wrap`);
      if (wrap.clientWidth && wrap.clientHeight) {
        previewCamera.aspect = wrap.clientWidth / wrap.clientHeight;
        previewCamera.updateProjectionMatrix();
        previewControls.update(); // independent navigation — this tab's own orbit/pan/light hotkeys
        if (which === 'render' && (bloomEnabled || aoEnabled)) renderPreviewComposer.render();
        else r.render(scene, previewCamera);
      }
    } catch (err) {
      // A problem rendering the secondary preview should never take down
      // the main viewport's render loop with it.
      console.warn(`${which} preview render failed:`, err);
    }
  }

  const instFps = 1 / Math.max(dt, 0.0001);
  fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.9 + instFps * 0.1 : instFps;
  const statsEl = document.getElementById('render-stats-overlay');
  if (statsEl && !statsEl.classList.contains('hidden')) {
    let totalCards = 0, totalTris = 0;
    guides.forEach((g) => {
      totalCards += g.cardsGroup.children.length;
      g.cardsGroup.children.forEach((card) => {
        const idx = card.geometry.getIndex();
        totalTris += idx ? idx.count / 3 : 0;
      });
    });
    statsEl.textContent = `FPS    ${fpsSmoothed.toFixed(1)}\nGuides ${guides.length}\nCards  ${totalCards}\nQuads  ${totalTris / 2}\nTris   ${totalTris}`;
  }

  requestAnimationFrame(animate);
}

if (window.hcsAPI) {
  window.hcsAPI.onMenuOpenProject(() => document.getElementById('btn-open-project').click());
  window.hcsAPI.onMenuSaveProject(() => document.getElementById('btn-save-project').click());
  window.hcsAPI.onMenuExportObj(() => document.getElementById('btn-export-obj').click());
  window.hcsAPI.onMenuNewProject(() => {
    if (guides.length > 0 && !confirm('Start a new project? Anything unsaved will be lost.')) return;
    guides.slice().forEach((g) => scene.remove(g.line, g.pointsGroup, g.cardsGroup));
    guides.length = 0;
    guideCounter = 0;
    layers.length = 0;
    layers.push({ id: 0, name: 'Layer 1' });
    nextLayerId = 1;
    activeLayerId = 0;
    lastProjectFilePath = null;
    store.atlasImage = null;
    store.atlasImageURL = null;
    store.atlasFileName = '';
    store.regions = [];
    emit('regions-changed', store.regions);
    selectGuide(makeGuide());
    updateBudgetDashboard();
    hintEl.textContent = 'New project started.';
  });
  window.hcsAPI.onMenuLoadAutosave(async () => {
    const info = await window.hcsAPI.getAutosaveInfo();
    if (!info) {
      alert('No autosave found yet.');
      return;
    }
    const when = new Date(info.mtime).toLocaleString();
    if (!confirm(`Load autosave from ${when}? Anything unsaved in the current project will be lost.`)) return;
    loadProjectFromJSON(info.content, null); // null: this is a recovery copy, not "the" project file — don't silently adopt it as the autosave/Ctrl+S target
    hintEl.textContent = `Loaded autosave from ${when}.`;
  });
  window.hcsAPI.onMenuUndo(() => {
    const activeTabBtn = document.querySelector('.tab-btn.active');
    const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'viewport';
    if (activeTab === 'texturegen') undoPaint();
    else if (activeTab === 'atlas') undoAtlas();
    else undo();
  });
}

// Kick off with one guide ready to go.
selectGuide(makeGuide());
updateBudgetDashboard();
requestAnimationFrame(animate);
