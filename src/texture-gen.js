import { loadImageFromDataURL } from './atlas.js';

// Two-canvas setup: `paint` holds the raw brush strokes (source of truth),
// `visible` shows paint + every enabled modifier recomputed from scratch each
// time — so modifiers never compound on top of their own previous output.

const visible = document.getElementById('texgen-canvas');
const vctx = visible.getContext('2d');

const paint = document.createElement('canvas');
paint.width = visible.width;
paint.height = visible.height;
const pctx = paint.getContext('2d', { willReadFrequently: true });

let currentBrush = 'paint';
let isDrawing = false;
let dragStart = null; // {x,y} in canvas pixel space, for gradient shapes

// --- Color palette: not fixed at two entries — "+ Color" grows it. One
// entry is always the "primary" (solid brush / gradient start) and one is
// the "secondary" (gradient/radial end color); any swatch can be assigned
// either role, and its own color is editable independently of that role.
let palette = ['#3b2418', '#c9a876'];
let primaryIndex = 0;
let secondaryIndex = 1;

const paletteEl = document.getElementById('texgen-palette');

function renderPalette() {
  paletteEl.innerHTML = '';
  palette.forEach((color, i) => {
    const item = document.createElement('div');
    item.className = 'palette-item';

    const swatch = document.createElement('div');
    swatch.className = 'palette-swatch';
    if (i === primaryIndex) swatch.classList.add('is-primary');
    if (i === secondaryIndex) swatch.classList.add('is-secondary');
    swatch.style.background = color;

    const input = document.createElement('input');
    input.type = 'color';
    input.value = color;
    input.addEventListener('input', () => {
      palette[i] = input.value;
      swatch.style.background = input.value;
    });
    swatch.appendChild(input);

    const controls = document.createElement('div');
    controls.className = 'palette-swatch-controls';

    const pBtn = document.createElement('button');
    pBtn.className = 'swatch-mini-btn' + (i === primaryIndex ? ' active-p' : '');
    pBtn.textContent = 'P';
    pBtn.title = 'Use as primary (solid brush / gradient start)';
    pBtn.addEventListener('click', () => { primaryIndex = i; renderPalette(); });

    const sBtn = document.createElement('button');
    sBtn.className = 'swatch-mini-btn' + (i === secondaryIndex ? ' active-s' : '');
    sBtn.textContent = 'S';
    sBtn.title = 'Use as secondary (gradient/radial end color)';
    sBtn.addEventListener('click', () => { secondaryIndex = i; renderPalette(); });

    controls.append(pBtn, sBtn);
    item.append(swatch, controls);

    if (palette.length > 2) {
      const removeBtn = document.createElement('span');
      removeBtn.className = 'palette-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove color';
      removeBtn.addEventListener('click', () => {
        palette.splice(i, 1);
        if (primaryIndex >= palette.length) primaryIndex = palette.length - 1;
        if (secondaryIndex >= palette.length) secondaryIndex = palette.length - 1;
        renderPalette();
      });
      item.appendChild(removeBtn);
    }

    paletteEl.appendChild(item);
  });
}

document.getElementById('btn-texgen-add-color').addEventListener('click', () => {
  palette.push(palette[primaryIndex] || '#ffffff');
  renderPalette();
});

renderPalette();

const sizeSlider = document.getElementById('texgen-size');
const sizeVal = document.getElementById('texgen-size-val');
const opacitySlider = document.getElementById('texgen-opacity');
const opacityVal = document.getElementById('texgen-opacity-val');
const falloffCheckbox = document.getElementById('texgen-falloff');
const lazyCheckbox = document.getElementById('texgen-lazy');
const lazyRadiusInput = document.getElementById('texgen-lazy-radius');
const lazyRadiusVal = document.getElementById('texgen-lazy-radius-val');
const lazyRadiusWrap = document.getElementById('texgen-lazy-radius-wrap');
const gradientShapeSelect = document.getElementById('texgen-gradient-shape');

sizeSlider.addEventListener('input', () => { sizeVal.textContent = sizeSlider.value; });
opacitySlider.addEventListener('input', () => { opacityVal.textContent = Number(opacitySlider.value).toFixed(2); });
lazyCheckbox.addEventListener('change', () => { lazyRadiusWrap.style.display = lazyCheckbox.checked ? 'flex' : 'none'; });
lazyRadiusInput.addEventListener('input', () => { lazyRadiusVal.textContent = lazyRadiusInput.value; });

document.querySelectorAll('.brush-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.brush-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentBrush = btn.dataset.brush;
    if (btn.dataset.brush !== 'pen') penPath = []; // switching away cancels any in-progress pen strand
    lazyAnchor = null;
    document.getElementById('paint-brush-options').style.display = (currentBrush === 'paint' || currentBrush === 'eraser') ? 'flex' : 'none';
    gradientShapeSelect.style.display = currentBrush === 'gradient' ? '' : 'none';
    if (currentBrush !== 'paint' && currentBrush !== 'eraser') {
      document.getElementById('texgen-cursor-ring').classList.add('hidden');
      visible.style.cursor = 'crosshair';
    }
  });
});
document.getElementById('paint-brush-options').style.display = 'flex';
gradientShapeSelect.style.display = 'none';

function canvasPos(evt) {
  const rect = visible.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * visible.width,
    y: ((evt.clientY - rect.top) / rect.height) * visible.height,
  };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --- Undo: one snapshot per discrete action (a whole drag/click gesture),
// not one per pixel — mirrors the app's guide-undo granularity.
let paintUndoStack = [];
export function pushPaintUndo() {
  paintUndoStack.push({ paint: paint.toDataURL(), flow: flowCanvas.toDataURL() });
  if (paintUndoStack.length > 30) paintUndoStack.shift();
}
export function undoPaint() {
  if (paintUndoStack.length === 0) return false;
  const snap = paintUndoStack.pop();
  const img = new Image();
  const flowImg = new Image();
  let pending = 2;
  const done = () => {
    if (--pending > 0) return;
    pctx.clearRect(0, 0, paint.width, paint.height);
    pctx.drawImage(img, 0, 0);
    fctx.clearRect(0, 0, flowCanvas.width, flowCanvas.height);
    fctx.drawImage(flowImg, 0, 0);
    renderOutput();
  };
  img.onload = done;
  flowImg.onload = done;
  img.src = snap.paint;
  flowImg.src = snap.flow;
  return true;
}

// --- Directional flow buffer: a real, derived map — not fabricated data.
// Every Paint Brush dab and every Pen segment has an actual direction (the
// way the user's stroke moved), which gets encoded as RG color here
// (dx -> R, dy -> G) at the same footprint as the visible stroke. Static
// shapes (Fill, Gradient) have no inherent direction, so they don't write to
// this buffer — it simply stays neutral (mid-gray = no direction) there.
const flowCanvas = document.createElement('canvas');
flowCanvas.width = paint.width;
flowCanvas.height = paint.height;
const fctx = flowCanvas.getContext('2d', { willReadFrequently: true });
fctx.fillStyle = 'rgb(128,128,128)';
fctx.fillRect(0, 0, flowCanvas.width, flowCanvas.height);

function stampFlowDab(x, y, dx, dy, radius) {
  const r = Math.round((dx * 0.5 + 0.5) * 255);
  const g = Math.round((dy * 0.5 + 0.5) * 255);
  fctx.fillStyle = `rgb(${r},${g},128)`;
  fctx.beginPath();
  fctx.arc(x, y, radius, 0, Math.PI * 2);
  fctx.fill();
}
function stampFlowLine(x0, y0, x1, y1, lineWidth) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const r = Math.round((dx / len * 0.5 + 0.5) * 255);
  const g = Math.round((dy / len * 0.5 + 0.5) * 255);
  fctx.strokeStyle = `rgb(${r},${g},128)`;
  fctx.lineWidth = lineWidth;
  fctx.lineCap = 'round';
  fctx.beginPath();
  fctx.moveTo(x0, y0);
  fctx.lineTo(x1, y1);
  fctx.stroke();
}
export function getFlowCanvas() { return flowCanvas; }

// --- Paint Brush: freehand, with optional soft falloff and lazy smoothing ---

let lastPaintPos = null; // for flow-direction tracking within one stroke
let lazyAnchor = null;   // for the lazy-brush stabilizer

// --- Bucket Fill: flood-fills the contiguous region under the click ---

function floodFill(startX, startY) {
  const w = paint.width, h = paint.height;
  const imgData = pctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

  const startIdx = (sy * w + sx) * 4;
  const startR = data[startIdx], startG = data[startIdx + 1], startB = data[startIdx + 2], startA = data[startIdx + 3];
  const [fr, fg, fb] = hexToRgb(palette[primaryIndex]);
  const fa = Math.round(Number(opacitySlider.value) * 255);
  if (startR === fr && startG === fg && startB === fb && startA === fa) return;

  const tolerance = 40;
  const tolSq = tolerance * tolerance * 4;
  const matches = (idx) => {
    const dr = data[idx] - startR, dg = data[idx + 1] - startG, db = data[idx + 2] - startB, da = data[idx + 3] - startA;
    return (dr * dr + dg * dg + db * db + da * da) <= tolSq;
  };

  const visited = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const vIdx = y * w + x;
    if (visited[vIdx]) continue;
    const idx = vIdx * 4;
    if (!matches(idx)) continue;
    visited[vIdx] = 1;
    data[idx] = fr; data[idx + 1] = fg; data[idx + 2] = fb; data[idx + 3] = fa;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  pctx.putImageData(imgData, 0, 0);
}

// --- Gradient shapes: Linear / Radial / Square / Diamond / Ellipse / Triangle ---

function commitGradientShape(shape, p0, p1) {
  const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return;

  pctx.globalAlpha = Number(opacitySlider.value);
  const primary = palette[primaryIndex], secondary = palette[secondaryIndex];

  if (shape === 'linear') {
    const grad = pctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    grad.addColorStop(0, primary);
    grad.addColorStop(1, secondary);
    pctx.fillStyle = grad;
    pctx.fillRect(x0, y0, w, h);
  } else if (shape === 'radial') {
    const radius = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const grad = pctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, radius);
    grad.addColorStop(0, primary);
    grad.addColorStop(1, secondary);
    pctx.fillStyle = grad;
    pctx.beginPath();
    pctx.arc(p0.x, p0.y, radius, 0, Math.PI * 2);
    pctx.fill();
  } else if (shape === 'triangle') {
    const grad = pctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, primary);
    grad.addColorStop(1, secondary);
    pctx.save();
    pctx.beginPath();
    pctx.moveTo(x0 + w / 2, y0);
    pctx.lineTo(x1, y1);
    pctx.lineTo(x0, y1);
    pctx.closePath();
    pctx.clip();
    pctx.fillStyle = grad;
    pctx.fillRect(x0, y0, w, h);
    pctx.restore();
  } else if (shape === 'ellipse') {
    pctx.save();
    pctx.beginPath();
    pctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    pctx.clip();
    // Squash a circular radial gradient to fit the ellipse's aspect ratio.
    pctx.translate(x0 + w / 2, y0 + h / 2);
    pctx.scale(1, h / w || 1);
    const grad = pctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    grad.addColorStop(0, primary);
    grad.addColorStop(1, secondary);
    pctx.fillStyle = grad;
    pctx.fillRect(-w / 2, -w / 2, w, w);
    pctx.restore();
  } else if (shape === 'square' || shape === 'diamond') {
    // Concentric box / diamond rings — canvas has no native gradient type
    // for these, so build them per-pixel.
    const cx = x0 + w / 2, cy = y0 + h / 2;
    const maxDist = Math.max(w, h) / 2;
    const [pr, pg, pb] = hexToRgb(primary);
    const [sr, sg, sb] = hexToRgb(secondary);
    const imgData = pctx.getImageData(x0, y0, Math.ceil(w), Math.ceil(h));
    const d = imgData.data;
    for (let y = 0; y < imgData.height; y++) {
      for (let x = 0; x < imgData.width; x++) {
        const dx = (x0 + x) - cx, dy = (y0 + y) - cy;
        const dist = shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx) + Math.abs(dy);
        const t = Math.max(0, Math.min(1, dist / maxDist));
        const i = (y * imgData.width + x) * 4;
        d[i] = pr + (sr - pr) * t;
        d[i + 1] = pg + (sg - pg) * t;
        d[i + 2] = pb + (sb - pb) * t;
        d[i + 3] = 255 * Number(opacitySlider.value);
      }
    }
    pctx.putImageData(imgData, x0, y0);
  }
  pctx.globalAlpha = 1;
}

// --- Width Profile: varies stroke width along its length (CSP-style taper) ---

// Custom width curve: three draggable handles (start, mid, end), evaluated
// as a quadratic Bezier with `mid` as the control point (so the curve
// bulges toward it rather than passing exactly through it — same
// convention as most simple pressure-curve editors).
let widthCurve = { startY: 1.0, midX: 0.5, midY: 0.3, endY: 1.0 };

function evalWidthCurve(t) {
  const p0y = widthCurve.startY, p1y = widthCurve.midY, p2y = widthCurve.endY;
  const y = (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * p1y + t * t * p2y;
  return y;
}

function widthProfileFactor(t, profile, taperFrac) {
  let raw;
  switch (profile) {
    case 'taper-both':
      if (t < taperFrac) raw = t / taperFrac;
      else if (t > 1 - taperFrac) raw = (1 - t) / taperFrac;
      else raw = 1;
      break;
    case 'taper-start':
      raw = t < taperFrac ? t / taperFrac : 1;
      break;
    case 'taper-end':
      raw = t > 1 - taperFrac ? (1 - t) / taperFrac : 1;
      break;
    case 'thin-thick-thin':
      raw = Math.sin(t * Math.PI);
      break;
    case 'thick-thin-thick':
      raw = 1 - Math.sin(t * Math.PI) * 0.85;
      break;
    case 'custom':
      raw = evalWidthCurve(t);
      break;
    default: // 'uniform'
      raw = 1;
  }
  return Math.max(0.05, raw); // never fully vanish — avoids a visible gap
}

function currentWidthProfile() {
  return {
    profile: document.getElementById('texgen-width-profile').value,
    taperFrac: Number(document.getElementById('texgen-taper-length').value) / 100,
  };
}

// --- Brush texture: procedurally different rendering per category — not
// literal brush-library assets, just genuinely distinct stroke rendering. ---

let customBrushImage = null; // user-imported stamp, used when Brush texture = "Imported"

function drawCustomImageDab(ctx, x, y, radius, colorHex, opacity) {
  const size = Math.max(2, radius * 2);
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(customBrushImage, 0, 0, size, size);
  // Tint the imported stamp to the current palette color, using its own
  // alpha as a mask — so it behaves like a real brush stamp, not a fixed
  // fixed-color sticker.
  tctx.globalCompositeOperation = 'source-atop';
  tctx.fillStyle = colorHex;
  tctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = opacity;
  ctx.drawImage(tmp, x - size / 2, y - size / 2, size, size);
  ctx.globalAlpha = 1;
}

document.getElementById('btn-import-brush').addEventListener('click', async () => {
  const result = await window.hcsAPI.importBrushTexture();
  if (!result) return;
  const mime = result.ext === '.jpg' || result.ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const dataURL = `data:${mime};base64,${result.data}`;
  const img = new Image();
  img.onload = () => {
    customBrushImage = img;
    const opt = document.getElementById('texgen-custom-brush-option');
    opt.disabled = false;
    opt.textContent = `Imported: ${result.filePath.split(/[/\\]/).pop()}`;
    document.getElementById('texgen-brush-texture').value = 'custom-image';
  };
  img.src = dataURL;
});

function drawBrushDab(ctx, x, y, radius, colorHex, baseOpacity) {
  const mode = document.getElementById('texgen-brush-texture').value;
  const useFalloff = falloffCheckbox.checked;

  function fillCircle(r, alpha, jitter) {
    ctx.globalAlpha = alpha;
    if (useFalloff) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, colorHex + 'ff');
      grad.addColorStop(1, colorHex + '00');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = colorHex;
    }
    ctx.beginPath();
    ctx.arc(x, y, r * (jitter || 1), 0, Math.PI * 2);
    ctx.fill();
  }

  if (mode === 'custom-image' && customBrushImage) {
    drawCustomImageDab(ctx, x, y, radius, colorHex, baseOpacity);
  } else if (mode === 'watercolor') {
    fillCircle(radius * 1.15, baseOpacity * 0.4);
  } else if (mode === 'marker') {
    fillCircle(radius, baseOpacity * 0.65);
  } else if (mode === 'ink') {
    fillCircle(radius, baseOpacity, 1 + (brushRand() - 0.5) * 0.08);
  } else if (mode === 'textured') {
    fillCircle(radius, baseOpacity);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let s = 0; s < 5; s++) {
      const ang = brushRand() * Math.PI * 2;
      const dist = brushRand() * radius * 0.8;
      ctx.globalAlpha = 0.15 + brushRand() * 0.25;
      ctx.beginPath();
      ctx.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, radius * 0.12 * brushRand(), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else {
    fillCircle(radius, baseOpacity); // 'smooth' (also the fallback if no brush imported yet)
  }
  ctx.globalAlpha = 1;
}

function eraseDab(ctx, x, y, radius, opacity) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = opacity;
  if (falloffCheckbox.checked) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = 'rgba(0,0,0,1)';
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function pathCumulativeLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lengths;
}

// Renders a whole recorded stroke as a sequence of dabs whose radius follows
// the Width Profile — used for both the live preview (ctx = vctx, redrawn
// each move) and the final commit (ctx = pctx, once on release). For the Pen
// tool with no taper, renders a real stroked path instead so Cap/Join/Miter
// actually take effect — canvas has no native variable-width stroke, so
// tapered profiles fall back to the dab approximation (no true caps there).
function drawTaperedStroke(ctx, points, baseRadius, colorHex, opacity, isPenStroke, erase) {
  if (points.length === 0) return;
  brushRand = mulberry32(strokeSeed); // every redraw of one stroke (preview, commit, pen re-commit) gets the same jitter
  const { profile, taperFrac } = currentWidthProfile();

  if (isPenStroke && profile === 'uniform' && points.length > 1 && !erase) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = baseRadius * 2;
    ctx.lineCap = document.getElementById('texgen-pen-cap').value;
    ctx.lineJoin = document.getElementById('texgen-pen-join').value;
    ctx.miterLimit = 4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const lengths = pathCumulativeLengths(points);
  const total = lengths[lengths.length - 1] || 1;
  const spacing = Math.max(1, baseRadius * 0.5); // 25% of brush diameter
  for (let i = 0; i < points.length; i++) {
    const prev = points[i - 1] || points[i];
    const seg = i > 0 ? lengths[i] - lengths[i - 1] : 0;
    const steps = Math.max(1, Math.ceil(seg / spacing));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const x = prev.x + (points[i].x - prev.x) * f;
      const y = prev.y + (points[i].y - prev.y) * f;
      const factor = widthProfileFactor((lengths[i] - seg * (1 - f)) / total, profile, taperFrac);
      const r = Math.max(0.5, baseRadius * factor);
      if (erase) eraseDab(ctx, x, y, r, opacity);
      else drawBrushDab(ctx, x, y, r, colorHex, opacity);
    }
  }
}

let currentStrokePoints = []; // recorded live-drag path for the Paint Brush, before it's committed
let penPath = []; // points already placed for the strand currently being drawn
let penStrokeBaseImageData = null; // paint-layer snapshot from just before this pen stroke began
let penStrokeBaseFlow = null;      // flow-buffer snapshot from the same moment, so Esc undoes the pen's flow lines too
let strokeSeed = 0;
// Seeded from the start point so repainting the same stroke reproduces it exactly.
const seedForStroke = (p) => MODIFIER_SEED ^ Math.imul(Math.round(p.x * 16), 73856093) ^ Math.imul(Math.round(p.y * 16), 19349663);
let brushRand = Math.random; // reseeded per stroke in drawTaperedStroke

visible.addEventListener('mousedown', (evt) => {
  const p = canvasPos(evt);

  if (currentBrush === 'pen') {
    if (penPath.length === 0) {
      pushPaintUndo();
      penStrokeBaseImageData = pctx.getImageData(0, 0, paint.width, paint.height);
      penStrokeBaseFlow = fctx.getImageData(0, 0, flowCanvas.width, flowCanvas.height);
      strokeSeed = seedForStroke(p);
    }
    penPath.push(p);

    // Commit immediately, every click — restore to the pre-stroke state
    // first so re-drawing the whole path fresh (with taper recalculated
    // against the CURRENT total length) never stacks on top of earlier
    // draws of the same path.
    pctx.putImageData(penStrokeBaseImageData, 0, 0);
    const lineWidth = Number(sizeSlider.value) / 4;
    drawTaperedStroke(pctx, penPath, lineWidth, palette[primaryIndex], Number(opacitySlider.value), true);
    for (let i = 1; i < penPath.length; i++) {
      stampFlowLine(penPath[i - 1].x, penPath[i - 1].y, penPath[i].x, penPath[i].y, lineWidth * 2);
    }
    renderOutput();
    return;
  }

  if (currentBrush === 'fill') {
    pushPaintUndo();
    floodFill(p.x, p.y);
    renderOutput();
    return;
  }

  isDrawing = true;
  dragStart = p;
  if (currentBrush === 'paint' || currentBrush === 'eraser') {
    pushPaintUndo();
    strokeSeed = seedForStroke(p);
    lastPaintPos = p;
    lazyAnchor = lazyCheckbox.checked ? { x: p.x, y: p.y } : null;
    currentStrokePoints = [p];
    renderOutput();
    drawTaperedStroke(vctx, currentStrokePoints, Number(sizeSlider.value) / 2, palette[primaryIndex], Number(opacitySlider.value), false, currentBrush === 'eraser');
  } else if (currentBrush === 'gradient') {
    pushPaintUndo();
    renderOutput();
  }
});

function finishPenStroke() {
  // Segments are already committed to pctx as each point was clicked —
  // finishing just ends the strand so the next click starts a fresh one.
  penPath = [];
  penStrokeBaseImageData = null;
  penStrokeBaseFlow = null;
  renderOutput();
}

function cancelPenStroke() {
  if (penStrokeBaseImageData) pctx.putImageData(penStrokeBaseImageData, 0, 0);
  if (penStrokeBaseFlow) fctx.putImageData(penStrokeBaseFlow, 0, 0);
  penPath = [];
  penStrokeBaseImageData = null;
  penStrokeBaseFlow = null;
  renderOutput();
}

visible.addEventListener('dblclick', () => {
  if (currentBrush === 'pen') finishPenStroke();
});

window.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && currentBrush === 'pen') cancelPenStroke();
  if (evt.key === 'Enter' && currentBrush === 'pen') finishPenStroke();
});

const BRUSH_HOTKEYS = { e: 'eraser', b: 'paint', g: 'gradient', p: 'pen' };
window.addEventListener('keydown', (evt) => {
  const brushForKey = BRUSH_HOTKEYS[evt.key.toLowerCase()];
  if (!brushForKey || evt.ctrlKey || evt.metaKey || evt.altKey) return;
  const activeTabBtn = document.querySelector('.tab-btn.active');
  if (!activeTabBtn || activeTabBtn.dataset.tab !== 'texturegen') return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  evt.preventDefault();
  document.querySelector(`.brush-btn[data-brush="${brushForKey}"]`).click();
});

const cursorRing = document.getElementById('texgen-cursor-ring');

function updateCursorRing(evt) {
  if (currentBrush !== 'paint' && currentBrush !== 'eraser') {
    cursorRing.classList.add('hidden');
    visible.style.cursor = 'crosshair';
    return;
  }
  visible.style.cursor = 'none';
  const rect = visible.getBoundingClientRect();
  const wrapRect = document.getElementById('texgen-canvas-wrap').getBoundingClientRect();
  const scale = rect.width / visible.width; // CSS size vs canvas pixel size
  const displaySize = Number(sizeSlider.value) * scale;
  cursorRing.style.width = `${displaySize}px`;
  cursorRing.style.height = `${displaySize}px`;
  // Positioned relative to #texgen-canvas-wrap (its actual CSS containing
  // block, since that's the nearest position:relative ancestor) — NOT
  // relative to the canvas itself, which can sit offset within the wrap
  // when centered. Using the canvas's own rect here was the bug.
  cursorRing.style.left = `${evt.clientX - wrapRect.left}px`;
  cursorRing.style.top = `${evt.clientY - wrapRect.top}px`;
  cursorRing.style.borderColor = currentBrush === 'eraser' ? '#ff6b6b' : '#f2b84b';
  cursorRing.classList.remove('hidden');
}

visible.addEventListener('mousemove', updateCursorRing);
visible.addEventListener('mouseenter', updateCursorRing);
visible.addEventListener('mouseleave', () => cursorRing.classList.add('hidden'));
sizeSlider.addEventListener('input', () => {
  if (!cursorRing.classList.contains('hidden')) {
    const rect = visible.getBoundingClientRect();
    const scale = rect.width / visible.width;
    const displaySize = Number(sizeSlider.value) * scale;
    cursorRing.style.width = `${displaySize}px`;
    cursorRing.style.height = `${displaySize}px`;
  }
});

visible.addEventListener('mousemove', (evt) => {
  const p = canvasPos(evt);

  if (currentBrush === 'pen' && penPath.length > 0) {
    renderOutput();
    const previewPath = [...penPath, p];
    drawTaperedStroke(vctx, previewPath, Number(sizeSlider.value) / 4, palette[primaryIndex], Number(opacitySlider.value), true);
    vctx.save();
    vctx.strokeStyle = '#f2b84b';
    vctx.setLineDash([5, 4]);
    vctx.lineWidth = 1;
    vctx.beginPath();
    const last = penPath[penPath.length - 1];
    vctx.moveTo(last.x, last.y);
    vctx.lineTo(p.x, p.y);
    vctx.stroke();
    vctx.restore();
    return;
  }

  if (!isDrawing) return;

  if (currentBrush === 'paint' || currentBrush === 'eraser') {
    let target = p;
    if (lazyAnchor) {
      const dx = p.x - lazyAnchor.x, dy = p.y - lazyAnchor.y;
      const dist = Math.hypot(dx, dy);
      const radius = Number(lazyRadiusInput.value);
      if (dist > radius) {
        const pull = dist - radius;
        lazyAnchor.x += (dx / dist) * pull;
        lazyAnchor.y += (dy / dist) * pull;
        target = { x: lazyAnchor.x, y: lazyAnchor.y };
      } else {
        target = null; // hasn't escaped the lazy radius yet — no new point
      }
    }
    if (target) {
      currentStrokePoints.push(target);
      if (currentBrush === 'paint' && lastPaintPos) {
        const dx = target.x - lastPaintPos.x, dy = target.y - lastPaintPos.y;
        const len = Math.hypot(dx, dy);
        const radius = Number(sizeSlider.value) / 2;
        const steps = Math.max(1, Math.ceil(len / Math.max(1, radius * 0.5)));
        if (len > 0.5) {
          for (let s = 1; s <= steps; s++) {
            stampFlowDab(lastPaintPos.x + dx * s / steps, lastPaintPos.y + dy * s / steps, dx / len, dy / len, radius);
          }
        }
      }
      lastPaintPos = target;
    }
    renderOutput();
    drawTaperedStroke(vctx, currentStrokePoints, Number(sizeSlider.value) / 2, palette[primaryIndex], Number(opacitySlider.value), false, currentBrush === 'eraser');
  } else if (currentBrush === 'gradient') {
    // Live dashed preview of the shape without touching the paint layer
    // until mouseup commits it.
    renderOutput();
    vctx.save();
    vctx.strokeStyle = '#f2b84b';
    vctx.setLineDash([6, 4]);
    const shape = gradientShapeSelect.value;
    if (shape === 'radial' || shape === 'ellipse') {
      const r = Math.hypot(p.x - dragStart.x, p.y - dragStart.y);
      vctx.beginPath();
      vctx.arc(dragStart.x, dragStart.y, r, 0, Math.PI * 2);
      vctx.stroke();
    } else {
      const x0 = Math.min(dragStart.x, p.x), y0 = Math.min(dragStart.y, p.y);
      vctx.strokeRect(x0, y0, Math.abs(p.x - dragStart.x), Math.abs(p.y - dragStart.y));
    }
    vctx.restore();
  }
});

window.addEventListener('mouseup', (evt) => {
  if (!isDrawing) return;
  isDrawing = false;
  if ((currentBrush === 'paint' || currentBrush === 'eraser') && currentStrokePoints.length > 0) {
    drawTaperedStroke(pctx, currentStrokePoints, Number(sizeSlider.value) / 2, palette[primaryIndex], Number(opacitySlider.value), false, currentBrush === 'eraser');
    currentStrokePoints = [];
  } else if (currentBrush === 'gradient' && dragStart) {
    const rect = visible.getBoundingClientRect();
    const inBounds = evt.clientX >= rect.left && evt.clientX <= rect.right && evt.clientY >= rect.top && evt.clientY <= rect.bottom;
    if (inBounds) commitGradientShape(gradientShapeSelect.value, dragStart, canvasPos(evt));
  }
  dragStart = null;
  lastPaintPos = null;
  lazyAnchor = null;
  renderOutput();
});

const widthProfileSelect = document.getElementById('texgen-width-profile');
const curveEditorWrap = document.getElementById('texgen-curve-editor-wrap');
const curveCanvas = document.getElementById('texgen-curve-editor');
const curveCtx = curveCanvas.getContext('2d');

function curveEditorPoints() {
  const w = curveCanvas.width, h = curveCanvas.height;
  const pad = 10;
  const toPx = (x, y) => ({ x: pad + x * (w - pad * 2), y: pad + (1 - y) * (h - pad * 2) });
  return {
    start: toPx(0, widthCurve.startY),
    mid: toPx(widthCurve.midX, widthCurve.midY),
    end: toPx(1, widthCurve.endY),
  };
}

function drawCurveEditor() {
  const w = curveCanvas.width, h = curveCanvas.height;
  curveCtx.clearRect(0, 0, w, h);

  // Grid
  curveCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  curveCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = (w / 4) * i, y = (h / 4) * i;
    curveCtx.beginPath(); curveCtx.moveTo(x, 0); curveCtx.lineTo(x, h); curveCtx.stroke();
    curveCtx.beginPath(); curveCtx.moveTo(0, y); curveCtx.lineTo(w, y); curveCtx.stroke();
  }

  // Curve
  const pts = curveEditorPoints();
  curveCtx.strokeStyle = '#f2b84b';
  curveCtx.lineWidth = 2;
  curveCtx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const y = evalWidthCurve(t);
    const pad = 10;
    const px = pad + t * (w - pad * 2);
    const py = pad + (1 - y) * (h - pad * 2);
    if (i === 0) curveCtx.moveTo(px, py); else curveCtx.lineTo(px, py);
  }
  curveCtx.stroke();

  // Handles
  [pts.start, pts.mid, pts.end].forEach((p) => {
    curveCtx.fillStyle = '#b968ff';
    curveCtx.strokeStyle = '#e9eaf0';
    curveCtx.lineWidth = 1.5;
    curveCtx.beginPath();
    curveCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    curveCtx.fill();
    curveCtx.stroke();
  });
}

let draggingHandle = null; // 'start' | 'mid' | 'end' | null

curveCanvas.addEventListener('mousedown', (evt) => {
  const rect = curveCanvas.getBoundingClientRect();
  const mx = (evt.clientX - rect.left) * (curveCanvas.width / rect.width);
  const my = (evt.clientY - rect.top) * (curveCanvas.height / rect.height);
  const pts = curveEditorPoints();
  let best = null, bestDist = 14;
  ['start', 'mid', 'end'].forEach((key) => {
    const d = Math.hypot(pts[key].x - mx, pts[key].y - my);
    if (d < bestDist) { bestDist = d; best = key; }
  });
  draggingHandle = best;
});

window.addEventListener('mousemove', (evt) => {
  if (!draggingHandle) return;
  const rect = curveCanvas.getBoundingClientRect();
  const pad = 10;
  const w = curveCanvas.width, h = curveCanvas.height;
  const nx = Math.max(0, Math.min(1, ((evt.clientX - rect.left) * (w / rect.width) - pad) / (w - pad * 2)));
  const ny = Math.max(0, Math.min(1, 1 - ((evt.clientY - rect.top) * (h / rect.height) - pad) / (h - pad * 2)));

  if (draggingHandle === 'start') widthCurve.startY = ny;
  else if (draggingHandle === 'end') widthCurve.endY = ny;
  else if (draggingHandle === 'mid') { widthCurve.midX = nx; widthCurve.midY = ny; }

  drawCurveEditor();
  if (widthProfileSelect.value === 'custom') renderOutput();
});

window.addEventListener('mouseup', () => { draggingHandle = null; });

document.getElementById('btn-curve-reset').addEventListener('click', () => {
  widthCurve = { startY: 1.0, midX: 0.5, midY: 0.3, endY: 1.0 };
  drawCurveEditor();
  if (widthProfileSelect.value === 'custom') renderOutput();
});

widthProfileSelect.addEventListener('change', () => {
  curveEditorWrap.classList.toggle('hidden', widthProfileSelect.value !== 'custom');
});
drawCurveEditor();

['texgen-width-profile', 'texgen-brush-texture'].forEach((id) => {
  document.getElementById(id).addEventListener('change', renderOutput);
});
document.getElementById('texgen-taper-length').addEventListener('input', (evt) => {
  document.getElementById('texgen-taper-length-val').textContent = `${evt.target.value}%`;
});

// --- Modifier stack: each reads from `paint`, writes into a working copy ---

const modEls = {
  roottipEnabled: document.getElementById('mod-roottip-enabled'),
  roottipRoot: document.getElementById('mod-roottip-root'),
  roottipTip: document.getElementById('mod-roottip-tip'),
  noiseEnabled: document.getElementById('mod-noise-enabled'),
  noise: document.getElementById('mod-noise'),
  bandsEnabled: document.getElementById('mod-bands-enabled'),
  bandsCount: document.getElementById('mod-bands-count'),
  bands: document.getElementById('mod-bands'),
  falloffEnabled: document.getElementById('mod-falloff-enabled'),
  falloff: document.getElementById('mod-falloff'),
  hueEnabled: document.getElementById('mod-hue-enabled'),
  hue: document.getElementById('mod-hue'),
};

document.getElementById('mod-noise-val');
[
  ['mod-noise', 'mod-noise-val', 2],
  ['mod-bands-count', 'mod-bands-count-val', 0],
  ['mod-bands', 'mod-bands-val', 2],
  ['mod-falloff', 'mod-falloff-val', 2],
  ['mod-hue', 'mod-hue-val', 2],
].forEach(([inputId, labelId, decimals]) => {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  input.addEventListener('input', () => {
    label.textContent = decimals > 0 ? Number(input.value).toFixed(decimals) : input.value;
    renderOutput();
  });
});
Object.values(modEls).forEach((el) => {
  if (el.type === 'checkbox' || el.type === 'color') el.addEventListener('input', renderOutput);
});

const noiseStyleSelect = document.getElementById('mod-noise-style');
const noiseAngleWrap = document.getElementById('mod-noise-angle-wrap');
noiseStyleSelect.addEventListener('change', () => {
  noiseAngleWrap.style.display = noiseStyleSelect.value === 'linear' ? 'flex' : 'none';
  renderOutput();
});
document.getElementById('mod-noise-angle').addEventListener('input', (evt) => {
  document.getElementById('mod-noise-angle-val').textContent = `${evt.target.value}°`;
  renderOutput();
});

function applyRootTipGradient(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, modEls.roottipRoot.value);
  grad.addColorStop(1, modEls.roottipTip.value);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop'; // recolor only where paint has alpha
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function applyHighlightBands(ctx, w, h) {
  const count = Number(modEls.bandsCount.value);
  const strength = Number(modEls.bands.value);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = strength;
  for (let i = 0; i < count; i++) {
    const x = (i / count) * w * 1.4 - w * 0.2;
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#000000';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + w / (count * 1.5), 0);
    ctx.lineTo(x + w / (count * 1.5) - h * 0.3, h);
    ctx.lineTo(x - h * 0.3, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function applyOpacityFalloff(ctx, w, h) {
  const start = Number(modEls.falloff.value);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in'; // multiplies existing alpha
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(Math.max(0, start - 0.01), 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

// Seeded so the same paint + settings always give the same modifier pixels.
const MODIFIER_SEED = 0x9e3779b9;
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let modRand = mulberry32(MODIFIER_SEED);

function applyLinearNoise(ctx, w, h) {
  const amount = Number(modEls.noise.value);
  const angleRad = (Number(document.getElementById('mod-noise-angle').value) * Math.PI) / 180;
  const dirX = Math.cos(angleRad), dirY = Math.sin(angleRad);
  const diag = Math.hypot(w, h);
  const lineCount = Math.round(80 + amount * 400);

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop'; // confine to already-painted (alpha) areas, same trick as Highlight Bands
  for (let i = 0; i < lineCount; i++) {
    const cx = modRand() * w;
    const cy = modRand() * h;
    const len = (0.05 + modRand() * 0.25) * diag * (0.3 + amount);
    const shade = modRand() < 0.5 ? 0 : 255; // dark or light strand streak
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},${0.15 + modRand() * 0.25 * amount})`;
    ctx.lineWidth = 0.6 + modRand() * 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - (dirX * len) / 2, cy - (dirY * len) / 2);
    ctx.lineTo(cx + (dirX * len) / 2, cy + (dirY * len) / 2);
    ctx.stroke();
  }
  ctx.restore();
}

function applyPixelModifiers(ctx, w, h) {
  const noiseStyle = document.getElementById('mod-noise-style').value;
  const doDotNoise = modEls.noiseEnabled.checked && noiseStyle === 'dots';
  const hueOn = modEls.hueEnabled.checked;
  if (!doDotNoise && !hueOn) return;

  const noiseAmt = Number(modEls.noise.value);
  const hueAmt = Number(modEls.hue.value);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue; // skip fully transparent pixels
    if (doDotNoise) {
      const n = (modRand() - 0.5) * 255 * noiseAmt;
      d[i] = Math.min(255, Math.max(0, d[i] + n));
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
    }
    if (hueOn) {
      const [h1, s1, l1] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      const jitter = (modRand() - 0.5) * hueAmt;
      const [r2, g2, b2] = hslToRgb((h1 + jitter + 1) % 1, s1, l1);
      d[i] = r2; d[i + 1] = g2; d[i + 2] = b2;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// The TRUE composite (paint + modifiers) lives in its own offscreen canvas,
// independent of what the visible canvas currently shows — so switching
// "View as" to Alpha/Luminance/etc. never corrupts the data that Export or
// "Send to Atlas Editor" actually uses.
const compositeCanvas = document.createElement('canvas');
compositeCanvas.width = paint.width;
compositeCanvas.height = paint.height;
const cctx = compositeCanvas.getContext('2d', { willReadFrequently: true });

function computeComposite() {
  const w = compositeCanvas.width, h = compositeCanvas.height;
  modRand = mulberry32(MODIFIER_SEED);
  cctx.clearRect(0, 0, w, h);
  cctx.drawImage(paint, 0, 0);
  if (modEls.roottipEnabled.checked) applyRootTipGradient(cctx, w, h);
  if (modEls.bandsEnabled.checked) applyHighlightBands(cctx, w, h);
  if (modEls.falloffEnabled.checked) applyOpacityFalloff(cctx, w, h);
  if (modEls.noiseEnabled.checked && document.getElementById('mod-noise-style').value === 'linear') {
    applyLinearNoise(cctx, w, h);
  }
  applyPixelModifiers(cctx, w, h); // dot-noise (if style = dots) + hue, both operate on final pixels
}

function renderOutput() {
  computeComposite();
  const w = visible.width, h = visible.height;
  vctx.clearRect(0, 0, w, h);

  const mode = document.getElementById('texgen-view-mode').value;
  if (mode === 'composite') {
    vctx.drawImage(compositeCanvas, 0, 0);
    return;
  }
  const imgData = cctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    let v;
    if (mode === 'alpha') v = d[i + 3];
    else if (mode === 'luminance') v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    else if (mode === 'red') v = d[i];
    else if (mode === 'green') v = d[i + 1];
    else v = d[i + 2]; // blue
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  vctx.putImageData(imgData, 0, 0);
}

document.getElementById('texgen-view-mode').addEventListener('change', renderOutput);

// Accessors for the Bake & Colors and Export tabs (separate modules).
export function getCompositeCanvas() { return compositeCanvas; }
export function getPaintCanvas() { return paint; }
export function refreshTextureOutput() { renderOutput(); }

document.getElementById('btn-texgen-clear').addEventListener('click', () => {
  pushPaintUndo();
  pctx.clearRect(0, 0, paint.width, paint.height);
  fctx.fillStyle = 'rgb(128,128,128)';
  fctx.fillRect(0, 0, flowCanvas.width, flowCanvas.height);
  renderOutput();
});

document.getElementById('btn-texgen-send').addEventListener('click', () => {
  computeComposite(); // ensure it's current even if the last render was a channel-preview mode
  const dataURL = compositeCanvas.toDataURL('image/png');
  loadImageFromDataURL(dataURL, 'generated-hair-texture.png');
  document.querySelector('.tab-btn[data-tab="atlas"]').click();
});

renderOutput();
