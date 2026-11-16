// End-to-end check: load the built app headless, open the sample project, run every export, validate the files.
// Run with `npm run build && npm test`.
import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import validator from 'gltf-validator';
import { PNG } from 'pngjs';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = `${ROOT}dist/GeoStrands.html`;
const SAMPLE = `${ROOT}examples/sample-hairstyle.geostrands.json`;
const CARDS = 182, TRIS = 728, GUIDES = 28; // sample project: 182 cards, each a front + back quad (2 tris each)
const LOCAL_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const t0 = Date.now();
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
// Runs a group of checks; an exception becomes one failed row instead of aborting the run.
const group = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, e.message.split('\n')[0]); } };

function report() {
  const w = Math.max(...results.map((r) => r.name.length));
  console.log(`\n${'CHECK'.padEnd(w)}  RESULT  DETAIL`);
  for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.ok ? 'PASS  ' : 'FAIL  '}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed || !results.length ? 1 : 0);
}

if (!existsSync(APP)) { check('dist/GeoStrands.html exists', false, 'run `npm run build` first'); report(); }

// --- Browser session: load, open sample, trigger exports ---
const executablePath = existsSync(LOCAL_CHROME) ? LOCAL_CHROME : process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

const files = {}; // export id -> { filename: Buffer }
let pending = [], tag = '';
page.on('download', (dl) => { const t = tag; pending.push(dl.path().then((p) => { (files[t] ||= {})[dl.suggestedFilename()] = readFileSync(p); })); });

// Clicks an export button and waits until `count` downloads have arrived.
async function exportVia(id, count) {
  pending = []; tag = id;
  await page.click('#btn-export-' + id);
  const deadline = Date.now() + 60_000;
  while (pending.length < count && Date.now() < deadline) await page.waitForTimeout(100);
  await Promise.all(pending);
  if (pending.length < count) throw new Error(`expected ${count} download(s), got ${pending.length}`);
}

await group('app loads', async () => {
  await page.goto(pathToFileURL(APP).href);
  await page.waitForFunction(() => !!window.hcsAPI, null, { timeout: 30_000 });
  check('app loads', true, 'dist/GeoStrands.html');
});

await group('sample project opens', async () => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-open-project')]);
  await fc.setFiles(SAMPLE);
  // budget dashboard shows the card count and texture memory once cards and atlas are in
  await page.waitForFunction((n) => document.getElementById('budget-cards').textContent.trim() === String(n) && document.getElementById('budget-texmem').textContent.trim() !== '—', CARDS, { timeout: 60_000 });
  check('sample project opens', true, `${CARDS} cards, atlas ${await page.textContent('#budget-texmem')}`);
});

const EXPORTS = [['gltf', 1], ['obj-plain', 1], ['obj-mtl', 3], ['fbx', 1], ['usd', 2], ['usd-curves', 1], ['simple', 6]];
await group('exports triggered', async () => {
  await page.click('.tab-btn[data-tab="export"]');
  await page.click('#btn-export-browse'); // web build: sets the folder to "Downloads"
  for (const id of ['exp-albedo', 'exp-alpha', 'exp-height', 'exp-roottip', 'exp-flow', 'exp-translucency']) await page.check('#' + id);
  for (const [id, n] of EXPORTS) await group(`export ${id}`, async () => { await exportVia(id, n); check(`export ${id}`, true, `${n} file(s)`); });
});
await page.waitForTimeout(500); // let late async errors surface
check('no page/console errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
await browser.close();

const need = (id, name) => { const f = files[id]?.[name]; if (!f) throw new Error(`${id}: ${name} not downloaded (got: ${Object.keys(files[id] || {}).join(', ')})`); return f; };

// --- GLB ---
await group('GLB', async () => {
  const glb = need('gltf', 'hair-cards.glb');
  const rep = await validator.validateBytes(new Uint8Array(glb), { maxIssues: 100 });
  const { numErrors, numWarnings, messages } = rep.issues;
  check('GLB gltf-validator', numErrors === 0 && numWarnings === 0, `${numErrors} errors, ${numWarnings} warnings ${messages.slice(0, 2).map((m) => m.code).join(' ')}`);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  const prims = json.meshes.flatMap((m) => m.primitives);
  const textured = prims.filter((p) => p.attributes.TEXCOORD_0 !== undefined && json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture);
  const tris = prims.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0);
  check('GLB cards all textured', json.meshes.length === CARDS && textured.length === prims.length && json.images?.length > 0,
    `${json.meshes.length} meshes, ${textured.length}/${prims.length} textured, ${json.images?.length || 0} image(s), ${tris} tris`);
});

// --- OBJ ---
function objWinding(txt) { // coincident face pairs (front/back of a card) must have opposite normals
  const L = txt.split(/\r?\n/);
  const V = L.filter((l) => l.startsWith('v ')).map((l) => l.split(/\s+/).slice(1).map(Number));
  const F = L.filter((l) => l.startsWith('f ')).map((l) => l.slice(2).trim().split(/\s+/).map((x) => +x.split('/')[0] - 1));
  const nrm = (f) => { const [a, b, c] = f.map((i) => V[i]); const u = b.map((x, k) => x - a[k]), w = c.map((x, k) => x - a[k]); return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
  const groups = new Map();
  F.forEach((f, i) => { const k = f.map((j) => V[j].map((x) => x.toFixed(4)).join(',')).sort().join('|'); (groups.get(k) || groups.set(k, []).get(k)).push(i); });
  let same = 0, opp = 0, single = 0;
  for (const g of groups.values()) {
    if (g.length < 2) { single++; continue; }
    const [n1, n2] = [nrm(F[g[0]]), nrm(F[g[1]])];
    n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > 0 ? same++ : opp++;
  }
  return { same, opp, single };
}
for (const id of ['obj-plain', 'obj-mtl']) await group(id, async () => {
  const label = id.toUpperCase();
  const txt = need(id, 'hair-cards.obj').toString('utf8');
  let tris = 0, bad = 0;
  new OBJLoader().parse(txt).traverse((o) => { if (o.isMesh) { const p = o.geometry.attributes.position; tris += p.count / 3; for (const v of p.array) if (!Number.isFinite(v)) bad++; } });
  check(`${label} OBJLoader triangles`, tris === TRIS && bad === 0, `${tris} tris, ${bad} non-finite`);
  const w = objWinding(txt);
  check(`${label} back faces opposite winding`, w.same === 0 && w.single === 0 && w.opp === CARDS, `${w.opp} opposite, ${w.same} same, ${w.single} unpaired`);
});
await group('MTL', async () => {
  const mtl = need('obj-mtl', 'hair-cards.mtl').toString('utf8');
  const maps = [...new Set(mtl.split(/\r?\n/).filter((l) => /^\s*map_/.test(l)).map((l) => l.trim().split(/\s+/).pop()))];
  const ok = maps.length > 0 && maps.every((m) => m.endsWith('.png') && files['obj-mtl'][m]);
  check('MTL references downloaded png', ok && need('obj-mtl', 'hair-cards.obj').toString().includes('mtllib'), maps.join(', ') || 'no map_ lines');
});

// --- FBX ---
await group('FBX', async () => {
  const txt = need('fbx', 'hair-cards.fbx').toString('utf8');
  const arr = (name) => { const m = txt.match(new RegExp('\\b' + name + ': \\*(\\d+) \\{\\s*a: ([^}]*)\\}')); return m && { decl: +m[1], vals: m[2].trim().split(',').map(Number) }; };
  const A = Object.fromEntries(['Vertices', 'PolygonVertexIndex', 'Normals', 'UV', 'UVIndex'].map((n) => [n, arr(n)]));
  const bad = Object.entries(A).filter(([, a]) => !a || a.decl !== a.vals.length || a.vals.some((x) => !Number.isFinite(x))).map(([n]) => n);
  const nv = A.Vertices ? A.Vertices.vals.length / 3 : 0;
  const pvi = A.PolygonVertexIndex?.vals || [];
  const outOfRange = pvi.filter((i) => (i < 0 ? -i - 1 : i) >= nv).length;
  const uvOut = (A.UVIndex?.vals || []).filter((i) => i >= (A.UV?.vals.length || 0) / 2).length;
  check('FBX array counts consistent', !bad.length && !outOfRange && !uvOut && A.Normals.vals.length / 3 === pvi.length && A.UVIndex.vals.length === pvi.length,
    bad.length ? `bad: ${bad.join(', ')}` : `${nv} verts, ${pvi.filter((i) => i < 0).length} polys, ${outOfRange + uvOut} bad idx`);
  let meshes = 0, verts = 0, mapName = null;
  // Node has no DOM: give FBXLoader's TextureLoader an inert <img> so the texture node can be parsed without fetching.
  globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, src: '' }) };
  new FBXLoader().parse(new TextEncoder().encode(txt).buffer, '').traverse((o) => {
    if (o.isMesh) { meshes++; verts += o.geometry.attributes.position.count; mapName ??= o.material?.map?.name ?? null; }
  });
  check('FBX parses with FBXLoader', meshes > 0 && verts > 0, `${meshes} mesh(es), ${verts} verts`);
  check('FBX material has texture map', !!mapName, mapName || 'no map');
});

// --- USD ---
const usdArray = (txt, key) => { const m = txt.match(new RegExp(`${key} = \\[([^\\]]*)\\]`)); return m ? m[1].split(/\s*,\s*(?![^(]*\))/).filter(Boolean) : []; };
await group('USD mesh', async () => {
  const txt = need('usd', 'hair-cards.usda').toString('utf8');
  const counts = usdArray(txt, 'faceVertexCounts').map(Number);
  const idx = usdArray(txt, 'faceVertexIndices');
  const ok = /metersPerUnit = 1\b/.test(txt) && /def Mesh "cards"/.test(txt) && /def Material "HairMaterial"/.test(txt) && /def Shader "DiffuseTexture"/.test(txt) &&
    counts.length === CARDS * 2 && idx.length === counts.reduce((s, n) => s + n, 0);
  const tex = txt.match(/asset inputs:file = @([^@]+)@/)?.[1];
  check('USD mesh prims and counts', ok, `${counts.length} faces, ${idx.length} indices, texture ${tex}`);
  check('USD mesh texture downloaded', tex && files.usd[tex.split('/').pop()], tex || 'no asset inputs:file');
});
await group('USD curves', async () => {
  const txt = need('usd-curves', 'hair-guides.usda').toString('utf8');
  const counts = usdArray(txt, 'curveVertexCounts').map(Number);
  const pts = usdArray(txt, 'point3f\\[\\] points');
  const ok = /metersPerUnit = 1\b/.test(txt) && /def BasisCurves "hair_guides"/.test(txt) && counts.length === GUIDES && pts.length === counts.reduce((s, n) => s + n, 0);
  check('USD curves prims and counts', ok, `${counts.length} curves, ${pts.length} points`);
});

// --- Texture maps ---
const pngs = Object.entries(files).flatMap(([id, fs]) => Object.keys(fs).filter((f) => f.endsWith('.png')).map((f) => [`${id}/${f}`, fs[f]]));
check('texture maps downloaded', pngs.length >= 8, `${pngs.length} png(s)`);
for (const [f, buf] of pngs) await group(`PNG ${f}`, async () => {
  const { width, height, data } = PNG.sync.read(buf);
  const ranges = [0, 1, 2, 3].map((c) => { let mn = 255, mx = 0; for (let i = c; i < data.length; i += 4) { mn = Math.min(mn, data[i]); mx = Math.max(mx, data[i]); } return mx - mn; });
  // the sample has no painted flow, so its flow map is legitimately uniform neutral (128,128)
  const neutralFlow = f.endsWith('_Flow.png') && data[0] === 128 && data[1] === 128 && data[3] === 255;
  check(`PNG ${f} non-blank`, width > 0 && (ranges.some((r) => r > 0) || neutralFlow), `${width}x${height}, channel ranges ${ranges.join('/')}${neutralFlow && !ranges.some((r) => r > 0) ? ' (neutral flow)' : ''}`);
});

report();
