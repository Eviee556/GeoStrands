// Windows release: compiles the launcher exe and zips it with the single-file app.
// Run after `npm run build`. Output: dist/GeoStrands-v<version>-win.zip
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'; // ships with every Windows 10/11
const stage = `${root}dist/GeoStrands`;
const zip = `${root}dist/GeoStrands-v${version}-win.zip`;

if (!existsSync(`${root}dist/GeoStrands.html`)) throw new Error('Run `npm run build` first.');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/win32icon:${join(root, 'launcher', 'app.ico')}`, `/out:${join(stage, 'GeoStrands.exe')}`, join(root, 'launcher', 'Launcher.cs')], { stdio: 'inherit' });
cpSync(`${root}dist/GeoStrands.html`, `${stage}/GeoStrands.html`);
cpSync(`${root}examples`, `${stage}/examples`, { recursive: true });
cpSync(`${root}LICENSE`, `${stage}/LICENSE.txt`);
writeFileSync(`${stage}/README.txt`, [
  `GeoStrands v${version} (work in progress)`,
  '',
  'Run: double-click GeoStrands.exe (keep it next to GeoStrands.html).',
  'Alternative: open GeoStrands.html in Chrome, Edge or Firefox.',
  'Sample project: File > Open Project... > examples/sample-hairstyle.geostrands.json',
  '',
  'Docs: https://github.com/Eviee556/GeoStrangs',
  'Created by Charlize Pauli. MIT License.',
  '',
].join('\r\n'));

rmSync(zip, { force: true });
execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zip, '-C', `${root}dist`, 'GeoStrands'], { stdio: 'inherit' });
if (!existsSync(zip)) throw new Error('zip was not created');
console.log(`packaged ${zip}`);
