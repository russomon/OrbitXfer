const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

let mainWindow;
let sendProcess = null;
let receiveProcess = null;
const streamBuffers = new Map();
const stagedFiles = new Set();
const transferRoots = new Set();
const tempStores = new Set();
let currentSendRoot = null;
let currentSendStore = null;
let currentReceiveStore = null;
let receivePoisoned = false;
const resumeMode = (process.env.ORBITXFER_RESUME_MODE || '1') === '1';

function defaultStoreDir() {
  return path.join(app.getPath('userData'), 'store');
}

function debugLogPath() {
  return path.join(app.getPath('userData'), 'orbitxfer-debug.log');
}

function appendDebug(line) {
  const payload = `[${new Date().toISOString()}] ${line}\n`;
  fs.promises.appendFile(debugLogPath(), payload).catch(() => {});
}

function createTransferRoot() {
  const root = path.join(
    app.getPath('userData'),
    'transfers',
    `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  transferRoots.add(root);
  return root;
}

function createTempStoreRoot() {
  const base = path.join(app.getPath('temp'), 'orbitxfer-store');
  const root = path.join(base, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  tempStores.add(root);
  return root;
}

async function cleanupTempStore(root) {
  if (!root) return;
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (_) {
    // ignore cleanup failures
  } finally {
    tempStores.delete(root);
  }
}

function transfersBaseDir() {
  return path.join(app.getPath('userData'), 'transfers');
}

async function cleanupTransferRoot(root) {
  if (!root) return;
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (_) {
    // ignore cleanup failures
  } finally {
    transferRoots.delete(root);
  }
}

async function cleanupStaleTransfers() {
  const base = transfersBaseDir();
  let entries = [];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const keep = new Set(transferRoots);
  if (sendProcess && currentSendRoot) {
    keep.add(currentSendRoot);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(base, entry.name);
    if (keep.has(fullPath)) continue;
    try {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      appendDebug(`cleanup_stale ${fullPath}`);
    } catch (_) {
      // ignore cleanup failures
    }
  }
}

async function cleanupStaleTempStores() {
  const base = path.join(app.getPath('temp'), 'orbitxfer-store');
  let entries = [];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const keep = new Set(tempStores);
  if (sendProcess && currentSendStore) {
    keep.add(currentSendStore);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(base, entry.name);
    if (keep.has(fullPath)) continue;
    try {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      appendDebug(`cleanup_temp_store ${fullPath}`);
    } catch (_) {
      // ignore cleanup failures
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  cleanupStaleTransfers();
  cleanupStaleTempStores();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('show-context-menu', (event) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Copy', role: 'copy' },
    { label: 'Paste', role: 'paste' },
    { type: 'separator' },
    { label: 'Select All', role: 'selectAll' }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select file to send'
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipcMain.handle('select-output', async (event, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'downloaded-file',
    title: 'Choose where to save the received file'
  });
  if (!result.canceled && result.filePath) return result.filePath;
  return null;
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose store directory'
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

function resolveCliPath(cliPath) {
  if (cliPath && fs.existsSync(cliPath)) return cliPath;

  const exeSuffix = process.platform === 'win32' ? '.exe' : '';

  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, `orbitxfer-iroh-cli${exeSuffix}`);
    if (fs.existsSync(packaged)) return packaged;
  }

  const candidates = [
    path.resolve(__dirname, '..', '..', 'OrbitXfer-iroh-cli', 'target', 'release', `orbitxfer-iroh-cli${exeSuffix}`),
    path.resolve(__dirname, '..', '..', 'OrbitXfer-iroh-cli', 'target', 'debug', `orbitxfer-iroh-cli${exeSuffix}`)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return `orbitxfer-iroh-cli${exeSuffix}`;
}

async function stageFileForSend(filePath, stagingRoot) {
  if (!stagingRoot) {
    const stats = await fs.promises.stat(filePath);
    appendDebug(`staging_skipped reason=direct source=${filePath}`);
    mainWindow?.webContents.send('process-event', {
      channel: 'send',
      payload: { type: 'staging_skipped', total: stats.size, reason: 'direct' }
    });
    return filePath;
  }

  await fs.promises.mkdir(stagingRoot, { recursive: true });

  const stats = await fs.promises.stat(filePath);
  const fileName = path.basename(filePath);
  const uniquePrefix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const stagedPath = path.join(stagingRoot, `${uniquePrefix}-${fileName}`);
  const stageMode = (process.env.ORBITXFER_STAGE_MODE || 'auto').toLowerCase();

  appendDebug(`staging_start source=${filePath} dest=${stagedPath} size=${stats.size}`);
  mainWindow?.webContents.send('process-event', {
    channel: 'send',
    payload: { type: 'staging_start', total: stats.size, name: fileName }
  });

  const finalizeSkip = (reason) => {
    appendDebug(`staging_skipped reason=${reason} source=${filePath}`);
    mainWindow?.webContents.send('process-event', {
      channel: 'send',
      payload: { type: 'staging_skipped', total: stats.size, reason }
    });
    return filePath;
  };

  const tryClone = async () => {
    await fs.promises.copyFile(filePath, stagedPath, fs.constants.COPYFILE_FICLONE);
    stagedFiles.add(stagedPath);
    appendDebug(`staging_clone dest=${stagedPath}`);
    mainWindow?.webContents.send('process-event', {
      channel: 'send',
      payload: { type: 'staging_complete', total: stats.size }
    });
    return stagedPath;
  };

  const tryLink = async () => {
    await fs.promises.link(filePath, stagedPath);
    stagedFiles.add(stagedPath);
    appendDebug(`staging_link dest=${stagedPath}`);
    mainWindow?.webContents.send('process-event', {
      channel: 'send',
      payload: { type: 'staging_complete', total: stats.size }
    });
    return stagedPath;
  };

  if (stageMode === 'none' || stageMode === 'direct') {
    return finalizeSkip(stageMode);
  }

  if (stageMode === 'clone') {
    return tryClone();
  }

  if (stageMode === 'link') {
    return tryLink();
  }

  if (stageMode !== 'copy') {
    try {
      return await tryClone();
    } catch (err) {
      appendDebug(`staging_clone_failed ${err.code || err.message || err}`);
    }
    try {
      return await tryLink();
    } catch (err) {
      appendDebug(`staging_link_failed ${err.code || err.message || err}`);
    }
    return finalizeSkip('auto-fallback');
  }

  await new Promise((resolve, reject) => {
    let copied = 0;
    const reader = fs.createReadStream(filePath);
    const writer = fs.createWriteStream(stagedPath);

    reader.on('data', (chunk) => {
      copied += chunk.length;
      mainWindow?.webContents.send('process-event', {
        channel: 'send',
        payload: { type: 'staging_progress', bytes: copied, total: stats.size }
      });
    });
    reader.on('error', reject);
    writer.on('error', reject);
    writer.on('close', resolve);
    reader.pipe(writer);
  });

  stagedFiles.add(stagedPath);
  appendDebug(`staging_complete dest=${stagedPath}`);
  mainWindow?.webContents.send('process-event', {
    channel: 'send',
    payload: { type: 'staging_complete', total: stats.size }
  });

  return stagedPath;
}

async function cleanupStagedFile(stagedPath) {
  if (!stagedPath || !stagedFiles.has(stagedPath)) return;
  try {
    await fs.promises.unlink(stagedPath);
  } catch (_) {
    // Ignore cleanup failures.
  } finally {
    stagedFiles.delete(stagedPath);
  }
}

function processStreamData(channel, data, isError) {
  const key = `${channel}:${isError ? 'stderr' : 'stdout'}`;
  const prev = streamBuffers.get(key) || '';
  const combined = prev + data.toString();
  const parts = combined.split(/\r?\n/);
  streamBuffers.set(key, parts.pop() || '');

  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (channel === 'receive' && line.includes('poisoned storage should not be used')) {
      receivePoisoned = true;
    }
    appendDebug(`${channel} ${isError ? 'stderr' : 'stdout'} ${line}`);
    const eventIdx = line.indexOf('OX_EVENT ');
    if (eventIdx !== -1) {
      const payload = line.slice(eventIdx + 'OX_EVENT '.length).trim();
      try {
        const parsed = JSON.parse(payload);
        mainWindow?.webContents.send('process-event', { channel, payload: parsed });
        continue;
      } catch (err) {
        // Fall through to log line if parsing fails.
      }
    }
    mainWindow?.webContents.send('process-log', { channel, message: line, isError });
  }
}

function streamProcess(proc, channel, options = {}) {
  proc.stdout.on('data', (data) => processStreamData(channel, data, false));
  proc.stderr.on('data', (data) => processStreamData(channel, data, true));
  proc.on('close', (code) => {
    if (typeof options.onExit === 'function') {
      options.onExit(code);
    }
    if (!options.suppressExit) {
      mainWindow?.webContents.send('process-exit', { channel, code });
    }
  });
}

ipcMain.handle('start-send', async (event, { cliPath, storeDir, filePath }) => {
  if (sendProcess) throw new Error('Send process already running');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File path is invalid');

  const resolvedCli = resolveCliPath(cliPath);
  mainWindow?.webContents.send('process-log', { channel: 'send', message: `CLI: ${resolvedCli}`, isError: false });
  const env = { ...process.env };
  const stageMode = (env.ORBITXFER_STAGE_MODE || 'direct').toLowerCase();
  if (resumeMode) {
    env.ORBITXFER_RESUME = '1';
    env.ORBITXFER_TICKET_MODE = env.ORBITXFER_TICKET_MODE || 'relay_only';
    env.ORBITXFER_KEY_PATH = env.ORBITXFER_KEY_PATH || path.join(app.getPath('userData'), 'identity.key');
  }
  let transferRoot = null;
  let stagingRoot = null;
  if (stageMode !== 'direct' && stageMode !== 'none') {
    transferRoot = createTransferRoot();
    currentSendRoot = transferRoot;
    stagingRoot = path.join(transferRoot, 'staging');
  }
  const storeIsTemp = !storeDir;
  const resolvedStore = storeDir || createTempStoreRoot();
  currentSendStore = resolvedStore;
  fs.mkdirSync(resolvedStore, { recursive: true });
  env.ORBITXFER_STORE_DIR = resolvedStore;
  env.ORBITXFER_IMPORT_MODE = 'try_reference';
  appendDebug(`send_start cli=${resolvedCli} store=${resolvedStore} staging=${stagingRoot || 'none'} mode=${stageMode}`);

  let stagedPath = null;
  try {
    stagedPath = await stageFileForSend(filePath, stagingRoot);
  } catch (err) {
    mainWindow?.webContents.send('process-event', {
      channel: 'send',
      payload: { type: 'staging_error', message: err.message || String(err) }
    });
    appendDebug(`staging_error ${err.message || err}`);
    await cleanupTransferRoot(transferRoot);
    if (storeIsTemp) {
      await cleanupTempStore(resolvedStore);
    }
    if (currentSendStore === resolvedStore) {
      currentSendStore = null;
    }
    throw err;
  }

  sendProcess = spawn(resolvedCli, ['send', stagedPath], { env });
  streamProcess(sendProcess, 'send');
  sendProcess.on('close', () => {
    sendProcess = null;
    cleanupStagedFile(stagedPath);
    cleanupTransferRoot(transferRoot);
    if (storeIsTemp) {
      cleanupTempStore(resolvedStore);
    }
    if (currentSendRoot === transferRoot) {
      currentSendRoot = null;
    }
    if (currentSendStore === resolvedStore) {
      currentSendStore = null;
    }
  });

  return { started: true, cliPath: resolvedCli };
});

ipcMain.handle('stop-send', async () => {
  if (!sendProcess) return { stopped: false };
  sendProcess.kill('SIGINT');
  if (sendProcess) {
    sendProcess.once('close', () => {});
  }
  return { stopped: true };
});

ipcMain.handle('start-receive', async (event, { cliPath, storeDir, ticket, fallbackTicket, outputPath, expectedSize }) => {
  if (receiveProcess) throw new Error('Receive process already running');
  if (!ticket) throw new Error('Ticket is required');
  if (!outputPath) throw new Error('Output path is required');

  const resolvedCli = resolveCliPath(cliPath);
  mainWindow?.webContents.send('process-log', { channel: 'receive', message: `CLI: ${resolvedCli}`, isError: false });
  const env = { ...process.env };
  receivePoisoned = false;
  if (storeDir) {
    env.ORBITXFER_STORE_DIR = storeDir;
    currentReceiveStore = storeDir;
  } else if (resumeMode) {
    const outputDir = path.dirname(outputPath);
    const ticketKey = crypto.createHash('sha256').update(ticket).digest('hex').slice(0, 12);
    const resumeRoot = path.join(outputDir, '.orbitxfer-store');
    const resumeStore = path.join(resumeRoot, ticketKey);
    env.ORBITXFER_STORE_DIR = resumeStore;
    currentReceiveStore = resumeStore;
  } else {
    delete env.ORBITXFER_STORE_DIR;
    currentReceiveStore = null;
  }
  if (currentReceiveStore) {
    fs.mkdirSync(currentReceiveStore, { recursive: true });
  }
  if (typeof expectedSize === 'number' && Number.isFinite(expectedSize)) {
    env.ORBITXFER_EXPECTED_SIZE = `${Math.floor(expectedSize)}`;
  } else {
    delete env.ORBITXFER_EXPECTED_SIZE;
  }

  const primaryTicket = ticket;
  const secondaryTicket = fallbackTicket || '';
  let attemptedFallback = false;

  const startAttempt = (ticketValue) => {
    receiveProcess = spawn(resolvedCli, ['receive', ticketValue, outputPath], { env });
    streamProcess(receiveProcess, 'receive', {
      suppressExit: true,
      onExit: (code) => {
        receiveProcess = null;
        if (code === 0) {
          mainWindow?.webContents.send('process-exit', { channel: 'receive', code });
          return;
        }
        if (!attemptedFallback && secondaryTicket) {
          attemptedFallback = true;
          if (receivePoisoned && currentReceiveStore) {
            try {
              fs.rmSync(currentReceiveStore, { recursive: true, force: true });
              fs.mkdirSync(currentReceiveStore, { recursive: true });
              appendDebug(`cleanup_receive_store_poisoned ${currentReceiveStore}`);
            } catch (_) {
              // ignore cleanup failures
            }
            receivePoisoned = false;
          }
          mainWindow?.webContents.send('process-event', {
            channel: 'receive',
            payload: { type: 'download_retry', message: 'Direct connection failed. Trying relay…' }
          });
          mainWindow?.webContents.send('process-log', {
            channel: 'receive',
            message: 'Direct connection failed. Retrying via relay ticket.',
            isError: true
          });
          startAttempt(secondaryTicket);
          return;
        }
        if (receivePoisoned && currentReceiveStore) {
          fs.promises
            .rm(currentReceiveStore, { recursive: true, force: true })
            .then(() => appendDebug(`cleanup_receive_store_poisoned ${currentReceiveStore}`))
            .catch(() => {});
          currentReceiveStore = null;
          receivePoisoned = false;
        }
        mainWindow?.webContents.send('process-exit', { channel: 'receive', code });
      }
    });
  };

  startAttempt(primaryTicket);

  return { started: true, cliPath: resolvedCli };
});

ipcMain.handle('stop-receive', async () => {
  if (!receiveProcess) return { stopped: false };
  receiveProcess.kill('SIGINT');
  return { stopped: true };
});

ipcMain.handle('cleanup-transfers', async () => {
  await cleanupStaleTransfers();
  return { ok: true };
});

ipcMain.handle('cleanup-receive-store', async () => {
  if (currentReceiveStore) {
    try {
      await fs.promises.rm(currentReceiveStore, { recursive: true, force: true });
      appendDebug(`cleanup_receive_store ${currentReceiveStore}`);
    } catch (_) {
      // ignore cleanup failures
    }
    currentReceiveStore = null;
  }
  return { ok: true };
});
