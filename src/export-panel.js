import { getCompositeCanvas, getFlowCanvas } from './texture-gen.js';
import { store } from './state.js';

// Maps come from the Texture Canva composite; when nothing was painted there,
// fall back to the loaded atlas image so the maps match the textured cards.
function getMapSourceCanvas() {
  const composite = getCompositeCanvas();
  if (!store.atlasImage) return composite;
  const data = composite.getContext('2d').getImageData(0, 0, composite.width, composite.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return composite;
  const canvas = document.createElement('canvas');
  canvas.width = store.atlasImage.width;
  canvas.height = store.atlasImage.height;
  canvas.getContext('2d').drawImage(store.atlasImage, 0, 0);
  return canvas;
}

// Channel sources this tool can honestly derive from a flat painted texture.
// (No Strand ID / Normal / Specular / Ambient — those need real per-strand
// or 3D surface data a 2D canvas doesn't have. Flow IS real: it's tracked
// live from actual Paint Brush / Pen stroke directions in Texture Canva.)
const CHANNEL_OPTIONS = [
  ['empty', 'Empty'],
  ['white', 'White'],
  ['black', 'Black'],
  ['alpha', 'Opacity (Alpha)'],
  ['luminance', 'Luminance (Height approx.)'],
  ['red', 'Red channel'],
  ['green', 'Green channel'],
  ['blue', 'Blue channel'],
  ['roottip', 'Root-Tip (vertical position)'],
  ['flowx', 'Directional Flow X'],
  ['flowy', 'Directional Flow Y'],
  ['translucency', 'Translucency (alpha-based approx.)'],
];

function channelValue(key, data, flowData, i, y, height) {
  switch (key) {
    case 'white': return 255;
    case 'alpha': return data[i + 3];
    case 'translucency': return 255 - data[i + 3];
    case 'red': return data[i];
    case 'green': return data[i + 1];
    case 'blue': return data[i + 2];
    case 'luminance': return Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    case 'roottip': return Math.round((y / Math.max(1, height - 1)) * 255);
    case 'flowx': return flowData[i];
    case 'flowy': return flowData[i + 1];
    default: return 0; // 'black' / 'empty'
  }
}

function buildSingleChannelCanvas(sourceCanvas, key) {
  const ctx = sourceCanvas.getContext('2d');
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const src = ctx.getImageData(0, 0, w, h).data;
  const flow = getFlowCanvas().getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const imgData = octx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = channelValue(key, src, flow, i, y, h);
      imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v; imgData.data[i + 3] = 255;
    }
  }
  octx.putImageData(imgData, 0, 0);
  return out;
}

function buildFlowMapCanvas(sourceCanvas) {
  // The flow buffer already IS an RG-encoded direction map — export it directly.
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(getFlowCanvas(), 0, 0);
  return out;
}

function buildPackedCanvas(sourceCanvas, channels) {
  const ctx = sourceCanvas.getContext('2d');
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const src = ctx.getImageData(0, 0, w, h).data;
  const flow = getFlowCanvas().getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const imgData = octx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      imgData.data[i] = channelValue(channels.R, src, flow, i, y, h);
      imgData.data[i + 1] = channelValue(channels.G, src, flow, i, y, h);
      imgData.data[i + 2] = channelValue(channels.B, src, flow, i, y, h);
      // An unassigned Alpha channel should default to opaque, not black,
      // so the exported image previews normally.
      imgData.data[i + 3] = channels.A === 'empty' ? 255 : channelValue(channels.A, src, flow, i, y, h);
    }
  }
  octx.putImageData(imgData, 0, 0);
  return out;
}

// --- Output folder / prefix ---

const folderInput = document.getElementById('export-folder');
document.getElementById('btn-export-browse').addEventListener('click', async () => {
  const folder = await window.hcsAPI.chooseExportFolder();
  if (folder) folderInput.value = folder;
});

// --- Simple export ---

document.getElementById('btn-export-simple').addEventListener('click', async () => {
  if (!folderInput.value) { alert('Choose an output folder first.'); return; }
  const prefix = document.getElementById('export-prefix').value || 'hair';
  const composite = getMapSourceCanvas();
  const files = [];

  if (document.getElementById('exp-albedo').checked) {
    files.push({ filename: `${prefix}_Albedo.png`, dataURL: composite.toDataURL('image/png') });
  }
  if (document.getElementById('exp-alpha').checked) {
    files.push({ filename: `${prefix}_Alpha.png`, dataURL: buildSingleChannelCanvas(composite, 'alpha').toDataURL('image/png') });
  }
  if (document.getElementById('exp-height').checked) {
    files.push({ filename: `${prefix}_Height.png`, dataURL: buildSingleChannelCanvas(composite, 'luminance').toDataURL('image/png') });
  }
  if (document.getElementById('exp-roottip').checked) {
    files.push({ filename: `${prefix}_RootTip.png`, dataURL: buildSingleChannelCanvas(composite, 'roottip').toDataURL('image/png') });
  }
  if (document.getElementById('exp-flow').checked) {
    files.push({ filename: `${prefix}_Flow.png`, dataURL: buildFlowMapCanvas(composite).toDataURL('image/png') });
  }
  if (document.getElementById('exp-translucency').checked) {
    files.push({ filename: `${prefix}_Translucency.png`, dataURL: buildSingleChannelCanvas(composite, 'translucency').toDataURL('image/png') });
  }

  if (files.length === 0) { alert('Enable at least one map to export.'); return; }
  const written = await window.hcsAPI.writeExportFiles(folderInput.value, files);
  alert(`Exported ${written.length} file(s) to ${folderInput.value}`);
});

// --- Advanced export (channel packing) ---

let outputImages = [
  { name: 'Mask', channels: { R: 'alpha', G: 'luminance', B: 'roottip', A: 'empty' } },
];
let nextOutputId = 1;

function channelSelectHTML(selected) {
  return CHANNEL_OPTIONS.map(([val, label]) =>
    `<option value="${val}" ${val === selected ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function renderOutputList() {
  const list = document.getElementById('export-advanced-list');
  list.innerHTML = '';
  outputImages.forEach((img, idx) => {
    const block = document.createElement('div');
    block.className = 'output-image-block';

    const header = document.createElement('div');
    header.className = 'output-image-header';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = img.name;
    nameInput.addEventListener('input', () => { img.name = nameInput.value; });
    const delBtn = document.createElement('button');
    delBtn.className = 'ghost-btn small';
    delBtn.textContent = '✕ Remove';
    delBtn.addEventListener('click', () => { outputImages.splice(idx, 1); renderOutputList(); });
    header.append(nameInput, delBtn);
    block.appendChild(header);

    ['R', 'G', 'B', 'A'].forEach((ch) => {
      const row = document.createElement('div');
      row.className = 'channel-row';
      const label = document.createElement('span');
      label.className = 'channel-label';
      label.textContent = ch;
      const select = document.createElement('select');
      select.innerHTML = channelSelectHTML(img.channels[ch]);
      select.addEventListener('change', () => { img.channels[ch] = select.value; });
      row.append(label, select);
      block.appendChild(row);
    });

    list.appendChild(block);
  });
}

document.getElementById('btn-add-output-image').addEventListener('click', () => {
  outputImages.push({ name: `Output${nextOutputId++}`, channels: { R: 'empty', G: 'empty', B: 'empty', A: 'empty' } });
  renderOutputList();
});

document.getElementById('btn-export-advanced').addEventListener('click', async () => {
  if (!folderInput.value) { alert('Choose an output folder first.'); return; }
  if (outputImages.length === 0) { alert('Add at least one output image.'); return; }
  const prefix = document.getElementById('export-prefix').value || 'hair';
  const composite = getMapSourceCanvas();

  const files = outputImages.map((img) => ({
    filename: `${prefix}_${img.name || 'Output'}.png`,
    dataURL: buildPackedCanvas(composite, img.channels).toDataURL('image/png'),
  }));

  const written = await window.hcsAPI.writeExportFiles(folderInput.value, files);
  alert(`Exported ${written.length} file(s) to ${folderInput.value}`);
});

renderOutputList();
