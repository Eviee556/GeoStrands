import { getCompositeCanvas, getPaintCanvas, refreshTextureOutput } from './texture-gen.js';

const canvas = document.getElementById('bakecolors-canvas');
const ctx = canvas.getContext('2d');

const targetSelect = document.getElementById('bc-target');
const sliders = {
  brightness: document.getElementById('bc-brightness'),
  contrast: document.getElementById('bc-contrast'),
  saturation: document.getElementById('bc-saturation'),
  hue: document.getElementById('bc-hue'),
};
const labels = {
  brightness: document.getElementById('bc-brightness-val'),
  contrast: document.getElementById('bc-contrast-val'),
  saturation: document.getElementById('bc-saturation-val'),
  hue: document.getElementById('bc-hue-val'),
};
const invertCheckbox = document.getElementById('bc-invert');
const remapEnabled = document.getElementById('bc-remap-enabled');
const remapDark = document.getElementById('bc-remap-dark');
const remapLight = document.getElementById('bc-remap-light');
const solidEnabled = document.getElementById('bc-solid-enabled');
const solidColor = document.getElementById('bc-solid-color');

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
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

// Builds the starting ImageData for the chosen Bake Target. Albedo is just
// the composite as-is; the others are honestly-derived single-channel views
// (same data Export's Simple/Advanced maps use), spread across RGB so the
// same brightness/contrast/etc. sliders still make sense on them.
function buildTargetImageData(source) {
  const w = source.width, h = source.height;
  const octx = source.getContext('2d');
  const src = octx.getImageData(0, 0, w, h);
  const target = targetSelect.value;
  if (target === 'albedo') return src;

  const out = ctx.createImageData(w, h);
  const sd = src.data, dd = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v;
      if (target === 'alpha') v = sd[i + 3];
      else if (target === 'height') v = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
      else v = (y / Math.max(1, h - 1)) * 255; // roottip
      dd[i] = dd[i + 1] = dd[i + 2] = v;
      dd[i + 3] = sd[i + 3]; // keep the real alpha mask so shape still reads correctly
    }
  }
  return out;
}

function applyAdjustments(imageData) {
  const brightness = Number(sliders.brightness.value);
  const contrast = Number(sliders.contrast.value);
  const saturation = Number(sliders.saturation.value) / 100;
  const hueShift = Number(sliders.hue.value) / 360;
  const invert = invertCheckbox.checked;
  const [darkR, darkG, darkB] = hexToRgb(remapDark.value);
  const [lightR, lightG, lightB] = hexToRgb(remapLight.value);
  const [solidR, solidG, solidB] = hexToRgb(solidColor.value);

  const contrast255 = contrast * 2.55;
  const contrastFactor = (259 * (contrast255 + 255)) / (255 * (259 - contrast255));

  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue; // leave fully transparent pixels alone
    let r = d[i], g = d[i + 1], b = d[i + 2];

    r += brightness * 2.55; g += brightness * 2.55; b += brightness * 2.55;
    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    if (saturation !== 0 || hueShift !== 0) {
      const [h, s, l] = rgbToHsl(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
      const newS = Math.max(0, Math.min(1, s + saturation));
      const newH = ((h + hueShift) % 1 + 1) % 1;
      [r, g, b] = hslToRgb(newH, newS, l);
    }

    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }

    if (remapEnabled.checked) {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      r = darkR + (lightR - darkR) * lum;
      g = darkG + (lightG - darkG) * lum;
      b = darkB + (lightB - darkB) * lum;
    }

    if (solidEnabled.checked) { r = solidR; g = solidG; b = solidB; }

    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }
}

export function refreshBakePreview() {
  const source = getCompositeCanvas();
  canvas.width = source.width;
  canvas.height = source.height;
  const imageData = buildTargetImageData(source);
  applyAdjustments(imageData);
  ctx.putImageData(imageData, 0, 0);
}

[targetSelect, remapEnabled, remapDark, remapLight, solidEnabled, solidColor].forEach((el) => {
  el.addEventListener('input', refreshBakePreview);
});

Object.entries(sliders).forEach(([key, input]) => {
  input.addEventListener('input', () => {
    labels[key].textContent = key === 'hue' ? `${input.value}°` : input.value;
    refreshBakePreview();
  });
});
invertCheckbox.addEventListener('change', refreshBakePreview);

document.getElementById('btn-bake-reset').addEventListener('click', () => {
  Object.values(sliders).forEach((input) => { input.value = 0; });
  labels.brightness.textContent = '0';
  labels.contrast.textContent = '0';
  labels.saturation.textContent = '0';
  labels.hue.textContent = '0°';
  invertCheckbox.checked = false;
  remapEnabled.checked = false;
  solidEnabled.checked = false;
  refreshBakePreview();
});

document.getElementById('btn-bake-apply').addEventListener('click', () => {
  // Write the adjusted result back into the paint layer itself — this is
  // the "permanent" part; modifiers in Texture Canva then apply on top of
  // this newly baked base, same as painting a fresh stroke would. Only
  // meaningful when baking the Albedo target — baking a derived view (Alpha/
  // Height/Root-Tip) back as if it were color would destroy the real colors,
  // so that's blocked with an explanation instead.
  if (targetSelect.value !== 'albedo') {
    alert('Baking only writes back into the Albedo (Color) target — switch to Albedo before baking, or use Export to save the other views as their own files.');
    return;
  }
  const paint = getPaintCanvas();
  const pctx = paint.getContext('2d');
  pctx.clearRect(0, 0, paint.width, paint.height);
  pctx.drawImage(canvas, 0, 0);
  refreshTextureOutput();

  document.getElementById('btn-bake-reset').click(); // baked adjustments are now "used up"
});
