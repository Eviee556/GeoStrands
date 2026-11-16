// Bundles src/ into one self-contained HTML file (dist/GeoStrands.html)
// that runs offline by double-clicking it, no server or install needed.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = (p) => new URL(`../src/${p}`, import.meta.url);
const read = (p) => readFileSync(src(p), 'utf8');
const dataURL = (p, mime) => `data:${mime};base64,${readFileSync(src(p)).toString('base64')}`;

const { outputFiles } = await build({
  stdin: {
    contents: ['texture-gen.js', 'bake-colors.js', 'export-panel.js', 'app.js'].map((f) => `import './${f}';`).join('\n'),
    resolveDir: new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  },
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  legalComments: 'none',
  // The head mesh is fetched at runtime; inline it so file:// works.
  plugins: [{
    name: 'inline-head-obj',
    setup(b) {
      b.onLoad({ filter: /app\.js$/ }, (args) => ({
        contents: readFileSync(args.path, 'utf8').replace("'./assets/head_placeholder.obj'", JSON.stringify(dataURL('assets/head_placeholder.obj', 'text/plain'))),
        loader: 'js',
      }));
    },
  }],
});

// Escape "</script" so inlined code can't terminate its own tag.
const js = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css" />', () => `<style>${read('style.css')}</style>`)
  .replace('href="assets/app-icon.png"', () => `href="${dataURL('assets/app-icon.png', 'image/png')}"`)
  .replace('<script src="platform-web.js"></script>', () => `<script>${read('platform-web.js')}</script>`)
  .replace(/\s*<script type="module" src="[^"]+"><\/script>/g, '')
  .replace('</body>', () => `<script type="module">${js}</script>\n</body>`);

if (html.includes('src="app.js"')) throw new Error('module tags were not stripped');
if ((html.match(/<\/script>/gi) || []).length !== 2) throw new Error('inlined code broke out of its script tag');
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/GeoStrands.html', import.meta.url), html);
console.log(`dist/GeoStrands.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
