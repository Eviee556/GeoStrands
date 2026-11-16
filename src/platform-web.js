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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }
  const b64ToBlob = (b64, type) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  };
  const textBlob = (s) => new Blob([s], { type: 'text/plain' });

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
    writeExportFiles: async (_folder, files) => files.map((f) => download(f.filename, b64ToBlob(f.dataURL.split(',')[1] || '', 'image/png'))),

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
