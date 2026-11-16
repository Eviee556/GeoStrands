import { store, emit } from './state.js';

const canvas = document.getElementById('atlas-canvas');
const ctx = canvas.getContext('2d');
const emptyHint = document.getElementById('atlas-empty-hint');
const filenameLabel = document.getElementById('atlas-filename');
const regionNameInput = document.getElementById('region-name');
const regionListEl = document.getElementById('region-list');

let selection = null; // {x0,y0,x1,y1} in canvas pixel space, while dragging or after release
let dragging = false;
let regionCounter = 1;

function redraw() {
  if (!store.atlasImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(store.atlasImage, 0, 0, canvas.width, canvas.height);

  // Existing tagged regions
  ctx.lineWidth = 2;
  store.regions.forEach((r) => {
    const x = r.u0 * canvas.width;
    const y = r.v0 * canvas.height;
    const w = (r.u1 - r.u0) * canvas.width;
    const h = (r.v1 - r.v0) * canvas.height;
    ctx.strokeStyle = '#b968ff';
    ctx.fillStyle = 'rgba(185,104,255,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#e9eaf0';
    ctx.font = '11px monospace';
    ctx.fillText(r.name, x + 4, y + 13);
  });

  // Live selection while dragging
  if (selection) {
    const { x0, y0, x1, y1 } = selection;
    ctx.strokeStyle = '#f2b84b';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }
}

function canvasPos(evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * canvas.width,
    y: ((evt.clientY - rect.top) / rect.height) * canvas.height,
  };
}

canvas.addEventListener('mousedown', (evt) => {
  if (!store.atlasImage) return;
  const p = canvasPos(evt);
  dragging = true;
  selection = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});

canvas.addEventListener('mousemove', (evt) => {
  if (!dragging) return;
  const p = canvasPos(evt);
  selection.x1 = p.x;
  selection.y1 = p.y;
  redraw();
});

window.addEventListener('mouseup', () => {
  dragging = false;
});

export function loadImageFromDataURL(dataURL, filename) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      store.atlasImage = img;
      store.atlasImageURL = dataURL;
      store.atlasFileName = filename;

      // Fit canvas to a reasonable working resolution, preserving aspect ratio.
      const maxDim = 900;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.style.display = 'block';
      emptyHint.style.display = 'none';
      filenameLabel.textContent = filename;
      redraw();
      emit('atlas-image-changed', img);
      resolve(img);
    };
    img.src = dataURL;
  });
}

document.getElementById('btn-import-atlas').addEventListener('click', async () => {
  const result = await window.hcsAPI.openAtlas();
  if (!result) return;

  if (result.ext === '.psd') {
    // MVP note: robust PSD layer/composite extraction needs a full PSD
    // decoder (e.g. ag-psd); not bundled yet.
    // If your PSD fails to preview here, use Photoshop's
    // File > Export > PNG (flattened) and import that instead — it is the
    // same pixel data FiberShop/Substance atlases ship as anyway.
    alert(
      'PSD import is best-effort in this build. If nothing appears, ' +
      'flatten and export the atlas as PNG from Photoshop and import that instead.'
    );
  }

  const mime = result.ext === '.jpg' || result.ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const dataURL = `data:${mime};base64,${result.data}`;
  loadImageFromDataURL(dataURL, result.filePath.split(/[/\\]/).pop());
});

// --- Undo: snapshot store.regions before any mutation ---
let regionUndoStack = [];
function pushRegionUndo() {
  const snap = { regions: JSON.stringify(store.regions), guideRegions: null };
  emit('region-undo-snapshot', snap); // app.js fills guideRegions, since guides point at regions by index
  regionUndoStack.push(snap);
  if (regionUndoStack.length > 30) regionUndoStack.shift();
}
export function clearAtlasUndo() {
  regionUndoStack = [];
}
export function undoAtlas() {
  if (regionUndoStack.length === 0) return false;
  const snap = regionUndoStack.pop();
  store.regions = JSON.parse(snap.regions);
  refreshRegionList();
  redraw();
  emit('regions-changed', store.regions);
  emit('region-undo-restore', snap.guideRegions);
  return true;
}

document.getElementById('btn-add-region').addEventListener('click', () => {
  if (!selection || !store.atlasImage) return;
  const x0 = Math.min(selection.x0, selection.x1);
  const x1 = Math.max(selection.x0, selection.x1);
  const y0 = Math.min(selection.y0, selection.y1);
  const y1 = Math.max(selection.y0, selection.y1);
  if (x1 - x0 < 4 || y1 - y0 < 4) return; // ignore accidental clicks

  pushRegionUndo();
  const name = (regionNameInput.value || `clump_${regionCounter}`).trim();
  regionCounter += 1;
  regionNameInput.value = `clump_${String(regionCounter).padStart(2, '0')}`;

  store.regions.push({
    name,
    u0: x0 / canvas.width,
    v0: y0 / canvas.height,
    u1: x1 / canvas.width,
    v1: y1 / canvas.height,
  });
  selection = null;
  refreshRegionList();
  redraw();
  emit('regions-changed', store.regions);
});

document.getElementById('btn-clear-regions').addEventListener('click', () => {
  pushRegionUndo();
  store.regions = [];
  refreshRegionList();
  redraw();
  emit('regions-changed', store.regions);
  emit('regions-cleared');
});

function refreshRegionList() {
  regionListEl.innerHTML = '';
  store.regions.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'region-item';

    const swatch = document.createElement('div');
    swatch.className = 'region-swatch';
    if (store.atlasImageURL) {
      swatch.style.backgroundImage = `url(${store.atlasImageURL})`;
      swatch.style.backgroundPosition = `-${r.u0 * 100}% -${r.v0 * 100}%`;
    }

    const label = document.createElement('div');
    label.className = 'region-name';
    label.textContent = r.name;

    const del = document.createElement('button');
    del.className = 'region-del';
    del.textContent = '✕';
    del.title = 'Delete region';
    del.addEventListener('click', () => {
      pushRegionUndo();
      store.regions.splice(i, 1);
      refreshRegionList();
      redraw();
      emit('regions-changed', store.regions);
      emit('region-deleted', i);
    });

    row.append(swatch, label, del);
    regionListEl.appendChild(row);
  });
}

export function restoreAtlasFromProject(projectAtlas) {
  if (!projectAtlas || !projectAtlas.imageURL) return Promise.resolve();
  store.regions = projectAtlas.regions || [];
  const loaded = loadImageFromDataURL(projectAtlas.imageURL, projectAtlas.fileName || 'restored-atlas');
  refreshRegionList();
  emit('regions-changed', store.regions);
  return loaded;
}
