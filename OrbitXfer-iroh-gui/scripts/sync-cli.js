const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const cliRoot = path.resolve(projectRoot, '..', 'OrbitXfer-iroh-cli');
const binDir = path.join(projectRoot, 'bin');

const candidates = [
  {
    label: 'release',
    source: path.join(cliRoot, 'target', 'release', 'orbitxfer-iroh-cli'),
    dest: path.join(binDir, 'orbitxfer-iroh-cli')
  },
  {
    label: 'release-windows',
    source: path.join(cliRoot, 'target', 'release', 'orbitxfer-iroh-cli.exe'),
    dest: path.join(binDir, 'orbitxfer-iroh-cli.exe')
  },
  {
    label: 'debug',
    source: path.join(cliRoot, 'target', 'debug', 'orbitxfer-iroh-cli'),
    dest: path.join(binDir, 'orbitxfer-iroh-cli')
  },
  {
    label: 'debug-windows',
    source: path.join(cliRoot, 'target', 'debug', 'orbitxfer-iroh-cli.exe'),
    dest: path.join(binDir, 'orbitxfer-iroh-cli.exe')
  }
];

function syncBinary({ label, source, dest }) {
  if (!fs.existsSync(source)) {
    return false;
  }

  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`Synced ${label} CLI: ${source} -> ${dest}`);
  return true;
}

const syncedAny = candidates.reduce((found, candidate) => syncBinary(candidate) || found, false);

if (!syncedAny) {
  console.error('No OrbitXfer CLI binary found to sync.');
  console.error(`Expected one of the built binaries under: ${path.join(cliRoot, 'target')}`);
  process.exit(1);
}
