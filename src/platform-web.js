// Browser platform layer: implements window.hcsAPI (file dialogs, saving,
// autosave, menu events) with standard web APIs so GeoStrands runs in any
// modern browser with no install. Loaded as a classic script before the app modules.
(() => {
  const AUTOSAVE_KEY = 'geostrands-autosave-v1';
  const menuHandlers = {};
  const onMenu = (name) => (cb) => { (menuHandlers[name] ||= []).push(cb); };
  const fireMenu = (name, ...args) => (menuHandlers[name] || []).forEach((cb) => cb(null, ...args));

  // Opens the native file picker; resolves null if the user cancels.
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = () => resolve(input.files[0] || null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  const extOf = (name) => (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const readText = (file) => file.text();
  const readBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  async function pickBinary(accept) {
    const file = await pickFile(accept);
    if (!file) return null;
    return { filePath: file.name, ext: extOf(file.name), data: await readBase64(file) };
  }
  async function pickText(accept) {
    const file = await pickFile(accept);
    if (!file) return null;
    return { filePath: file.name, content: await readText(file) };
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke late: slow machines start reading queued downloads seconds after click(), and an early revoke drops them silently.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return filename;
  }
  const b64ToBlob = (b64, type) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  };
  const textBlob = (s) => new Blob([s], { type: 'text/plain' });

  // Minimal store-only ZIP (no compression: the entries are PNGs, already compressed).
  // One download instead of many avoids the browser's "multiple downloads" block.
  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  async function zipBlob(entries) { // entries: [{ name, blob }]
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date(); // MS-DOS date/time fields
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const { name, blob } of entries) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
      parts.push(local, nameBytes, data);
      central.push(cd, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  window.hcsAPI = {
    openAtlas: () => pickBinary('.psd,.png,.jpg,.jpeg'),
    importBrushTexture: () => pickBinary('.png,.jpg,.jpeg'),
    importHeadTexture: () => pickBinary('.png,.jpg,.jpeg'),
    importHeadModel: () => pickText('.obj'),
    openProject: () => pickText('.json'),

    saveProject: async (json) => download('hair-project.geostrands.json', textBlob(json)),
    exportOBJ: async (objText) => download('hair-cards.obj', textBlob(objText)),
    exportOBJWithMTL: async (objText, mtlText, textureBase64) => {
      const objPath = download('hair-cards.obj', textBlob(objText));
      const mtlPath = download('hair-cards.mtl', textBlob(mtlText));
      const texturePath = textureBase64 ? download('hair-cards_albedo.png', b64ToBlob(textureBase64, 'image/png')) : null;
      return { objPath, mtlPath, texturePath };
    },
    exportGLB: async (b64) => download('hair-cards.glb', b64ToBlob(b64, 'model/gltf-binary')),
    exportText: async (_title, defaultPath, _filterName, _ext, content) => download(defaultPath, textBlob(content)),

    // Browsers can't write into an arbitrary folder, so "folder" exports go to the downloads folder.
    chooseExportFolder: async () => 'Downloads',
    // Several maps are bundled into one <prefix>_maps.zip; a single file downloads as-is.
    writeExportFiles: async (_folder, files) => {
      const toBlob = (f) => b64ToBlob(f.dataURL.split(',')[1] || '', 'image/png');
      if (files.length === 1) return [download(files[0].filename, toBlob(files[0]))];
      const zipName = files[0].filename.replace(/_[^_]*$/, '') + '_maps.zip';
      download(zipName, await zipBlob(files.map((f) => ({ name: f.filename, blob: toBlob(f) }))));
      return files.map((f) => f.filename);
    },

    autosaveWrite: async (_knownPath, json) => {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ content: json, mtime: new Date().toISOString() }));
      return 'browser storage';
    },
    getAutosaveInfo: async () => JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null'),

    onOpenPreferences: onMenu('preferences'),
    onMenuUndo: onMenu('undo'),
    onMenuNewProject: onMenu('new'),
    onMenuOpenProject: onMenu('open'),
    onMenuOpenRecentFile: onMenu('recent'),
    onMenuRecentFileMissing: onMenu('recent-missing'),
    onMenuLoadAutosave: onMenu('autosave'),
    onMenuSaveProject: onMenu('save'),
    onMenuExportObj: onMenu('export-obj'),
  };

  // In-page File/Edit menu replacing the native desktop menu bar.
  const MENU = [
    ['File', [['New Project', 'new'], ['Open Project…', 'open'], ['Load Autosave…', 'autosave'], ['Save Project (Ctrl+S)', 'save'], ['Export OBJ…', 'export-obj']]],
    ['Edit', [['Undo (Ctrl+Z)', 'undo'], ['Preferences… (Ctrl+,)', 'preferences']]],
  ];
  function buildMenuBar() {
    const bar = document.createElement('div');
    bar.id = 'web-menubar';
    MENU.forEach(([label, items]) => {
      const wrap = document.createElement('div');
      wrap.className = 'web-menu';
      const btn = document.createElement('button');
      btn.className = 'ghost-btn small';
      btn.textContent = label;
      const list = document.createElement('div');
      list.className = 'web-menu-list';
      items.forEach(([text, evt]) => {
        const item = document.createElement('button');
        item.textContent = text;
        item.onclick = () => { list.classList.remove('open'); fireMenu(evt); };
        list.appendChild(item);
      });
      btn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.web-menu-list.open').forEach((l) => l !== list && l.classList.remove('open'));
        list.classList.toggle('open');
      };
      wrap.append(btn, list);
      bar.appendChild(wrap);
    });
    document.addEventListener('click', () => document.querySelectorAll('.web-menu-list.open').forEach((l) => l.classList.remove('open')));
    const brand = document.getElementById('titlebar-brand');
    brand.after(bar);
  }

  window.addEventListener('keydown', (evt) => {
    if (!(evt.ctrlKey || evt.metaKey)) return;
    if (evt.code === 'KeyS') { evt.preventDefault(); fireMenu('save'); }
    if (evt.code === 'Comma') { evt.preventDefault(); fireMenu('preferences'); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildMenuBar);
  else buildMenuBar();
})();
