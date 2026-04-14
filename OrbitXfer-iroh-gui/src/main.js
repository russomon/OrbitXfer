const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const windowSessions = new Map();
const stagedFiles = new Set();
const transferRoots = new Set();
const tempStores = new Set();
const resumeMode = (process.env.ORBITXFER_RESUME_MODE || '1') === '1';

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

function activeTransferRoots() {
  const keep = new Set(transferRoots);
  for (const session of windowSessions.values()) {
    if (session.sendProcess && session.currentSendRoot) {
      keep.add(session.currentSendRoot);
    }
  }
  return keep;
}

function activeTempStores() {
  const keep = new Set(tempStores);
  for (const session of windowSessions.values()) {
    if (session.sendProcess && session.currentSendStore) {
      keep.add(session.currentSendStore);
    }
  }
  return keep;
}

async function cleanupStaleTransfers() {
  const base = transfersBaseDir();
  let entries = [];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const keep = activeTransferRoots();
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
  const keep = activeTempStores();
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

function createSession(window) {
  const session = {
    id: window.webContents.id,
    window,
    sendProcess: null,
    receiveProcess: null,
    receiveStopRequested: false,
    streamBuffers: new Map(),
    currentSendRoot: null,
    currentSendStore: null,
    currentReceiveStore: null,
    receivePoisoned: false
  };
  windowSessions.set(session.id, session);
  return session;
}

function getSessionFromSender(sender) {
  const session = windowSessions.get(sender.id);
  if (!session) {
    throw new Error('This OrbitXfer window no longer has an active transfer session.');
  }
  return session;
}

function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || null;
}

function sendToSession(session, channel, payload) {
  const target = session?.window;
  if (!target || target.isDestroyed()) return;
  target.webContents.send(channel, payload);
}

function stopChildProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGINT');
  } catch (_) {
    // ignore shutdown failures
  }
}

function destroySession(session) {
  if (!session) return;
  session.receiveStopRequested = true;
  stopChildProcess(session.sendProcess);
  stopChildProcess(session.receiveProcess);
  if (!session.sendProcess && session.currentSendRoot) {
    const root = session.currentSendRoot;
    session.currentSendRoot = null;
    cleanupTransferRoot(root);
  }
  if (!session.sendProcess && session.currentSendStore && tempStores.has(session.currentSendStore)) {
    const store = session.currentSendStore;
    session.currentSendStore = null;
    cleanupTempStore(store);
  }
  session.window = null;
}

function createWindow(bounds = {}) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    ...bounds,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'default',
    show: false
  });

  const session = createSession(window);

  window.loadFile(path.join(__dirname, 'index.html'));

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    destroySession(session);
    windowSessions.delete(session.id);
  });

  return window;
}

app.whenReady().then(() => {
  createWindow();
  cleanupStaleTransfers();
  cleanupStaleTempStores();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const session of windowSessions.values()) {
    destroySession(session);
  }
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

ipcMain.handle('open-new-window', async (event) => {
  const sourceWindow = getWindowFromEvent(event);
  const baseBounds = sourceWindow ? sourceWindow.getBounds() : null;
  const nextBounds = baseBounds
    ? { x: baseBounds.x + 36, y: baseBounds.y + 36 }
    : {};
  const window = createWindow(nextBounds);
  return { ok: true, id: window.webContents.id };
});

ipcMain.handle('select-file', async (event) => {
  const result = await dialog.showOpenDialog(getWindowFromEvent(event), {
    properties: ['openFile'],
    title: 'Select file to send'
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipcMain.handle('select-output', async (event, suggestedName) => {
  const result = await dialog.showSaveDialog(getWindowFromEvent(event), {
    defaultPath: suggestedName || 'downloaded-file',
    title: 'Choose where to save the received file'
  });
  if (!result.canceled && result.filePath) return result.filePath;
  return null;
});

ipcMain.handle('select-directory', async (event) => {
  const result = await dialog.showOpenDialog(getWindowFromEvent(event), {
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

async function stageFileForSend(session, filePath, stagingRoot) {
  if (!stagingRoot) {
    const stats = await fs.promises.stat(filePath);
    appendDebug(`window=${session.id} staging_skipped reason=direct source=${filePath}`);
    sendToSession(session, 'process-event', {
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

  appendDebug(`window=${session.id} staging_start source=${filePath} dest=${stagedPath} size=${stats.size}`);
  sendToSession(session, 'process-event', {
    channel: 'send',
    payload: { type: 'staging_start', total: stats.size, name: fileName }
  });

  const finalizeSkip = (reason) => {
    appendDebug(`window=${session.id} staging_skipped reason=${reason} source=${filePath}`);
    sendToSession(session, 'process-event', {
      channel: 'send',
      payload: { type: 'staging_skipped', total: stats.size, reason }
    });
    return filePath;
  };

  const tryClone = async () => {
    await fs.promises.copyFile(filePath, stagedPath, fs.constants.COPYFILE_FICLONE);
    stagedFiles.add(stagedPath);
    appendDebug(`window=${session.id} staging_clone dest=${stagedPath}`);
    sendToSession(session, 'process-event', {
      channel: 'send',
      payload: { type: 'staging_complete', total: stats.size }
    });
    return stagedPath;
  };

  const tryLink = async () => {
    await fs.promises.link(filePath, stagedPath);
    stagedFiles.add(stagedPath);
    appendDebug(`window=${session.id} staging_link dest=${stagedPath}`);
    sendToSession(session, 'process-event', {
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
      appendDebug(`window=${session.id} staging_clone_failed ${err.code || err.message || err}`);
    }
    try {
      return await tryLink();
    } catch (err) {
      appendDebug(`window=${session.id} staging_link_failed ${err.code || err.message || err}`);
    }
    return finalizeSkip('auto-fallback');
  }

  await new Promise((resolve, reject) => {
    let copied = 0;
    const reader = fs.createReadStream(filePath);
    const writer = fs.createWriteStream(stagedPath);

    reader.on('data', (chunk) => {
      copied += chunk.length;
      sendToSession(session, 'process-event', {
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
  appendDebug(`window=${session.id} staging_complete dest=${stagedPath}`);
  sendToSession(session, 'process-event', {
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

function processStreamData(session, channel, data, isError) {
  const key = `${channel}:${isError ? 'stderr' : 'stdout'}`;
  const prev = session.streamBuffers.get(key) || '';
  const combined = prev + data.toString();
  const parts = combined.split(/\r?\n/);
  session.streamBuffers.set(key, parts.pop() || '');

  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (channel === 'receive' && line.includes('poisoned storage should not be used')) {
      session.receivePoisoned = true;
    }
    appendDebug(`window=${session.id} ${channel} ${isError ? 'stderr' : 'stdout'} ${line}`);
    const eventIdx = line.indexOf('OX_EVENT ');
    if (eventIdx !== -1) {
      const payload = line.slice(eventIdx + 'OX_EVENT '.length).trim();
      try {
        const parsed = JSON.parse(payload);
        sendToSession(session, 'process-event', { channel, payload: parsed });
        continue;
      } catch (_) {
        // Fall through to log line if parsing fails.
      }
    }
    sendToSession(session, 'process-log', { channel, message: line, isError });
  }
}

function streamProcess(session, proc, channel, options = {}) {
  proc.stdout.on('data', (data) => processStreamData(session, channel, data, false));
  proc.stderr.on('data', (data) => processStreamData(session, channel, data, true));
  proc.on('close', (code) => {
    if (typeof options.onExit === 'function') {
      options.onExit(code);
    }
    if (!options.suppressExit) {
      sendToSession(session, 'process-exit', { channel, code });
    }
  });
}

ipcMain.handle('start-send', async (event, { cliPath, storeDir, filePath, sendMode }) => {
  const session = getSessionFromSender(event.sender);
  if (session.sendProcess) throw new Error('Send process already running in this window');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File path is invalid');

  const resolvedCli = resolveCliPath(cliPath);
  sendToSession(session, 'process-log', { channel: 'send', message: `CLI: ${resolvedCli}`, isError: false });
  const env = { ...process.env };
  const ticketMode = sendMode === 'direct' ? 'direct_only' : 'full';
  const stageMode = (env.ORBITXFER_STAGE_MODE || 'direct').toLowerCase();
  if (resumeMode) {
    env.ORBITXFER_RESUME = '1';
    env.ORBITXFER_TICKET_MODE = ticketMode;
    env.ORBITXFER_KEY_PATH = env.ORBITXFER_KEY_PATH || path.join(app.getPath('userData'), 'identity.key');
  } else {
    env.ORBITXFER_TICKET_MODE = ticketMode;
  }
  let transferRoot = null;
  let stagingRoot = null;
  if (stageMode !== 'direct' && stageMode !== 'none') {
    transferRoot = createTransferRoot();
    session.currentSendRoot = transferRoot;
    stagingRoot = path.join(transferRoot, 'staging');
  }
  const storeIsTemp = !storeDir;
  const resolvedStore = storeDir || createTempStoreRoot();
  session.currentSendStore = resolvedStore;
  fs.mkdirSync(resolvedStore, { recursive: true });
  env.ORBITXFER_STORE_DIR = resolvedStore;
  env.ORBITXFER_IMPORT_MODE = 'try_reference';
  appendDebug(
    `window=${session.id} send_start cli=${resolvedCli} store=${resolvedStore} staging=${stagingRoot || 'none'} mode=${stageMode}`
  );

  let stagedPath = null;
  try {
    stagedPath = await stageFileForSend(session, filePath, stagingRoot);
  } catch (err) {
    sendToSession(session, 'process-event', {
      channel: 'send',
      payload: { type: 'staging_error', message: err.message || String(err) }
    });
    appendDebug(`window=${session.id} staging_error ${err.message || err}`);
    await cleanupTransferRoot(transferRoot);
    if (storeIsTemp) {
      await cleanupTempStore(resolvedStore);
    }
    if (session.currentSendRoot === transferRoot) {
      session.currentSendRoot = null;
    }
    if (session.currentSendStore === resolvedStore) {
      session.currentSendStore = null;
    }
    throw err;
  }

  const proc = spawn(resolvedCli, ['send', stagedPath], { env });
  session.sendProcess = proc;
  streamProcess(session, proc, 'send');
  proc.on('close', () => {
    if (session.sendProcess === proc) {
      session.sendProcess = null;
    }
    cleanupStagedFile(stagedPath);
    cleanupTransferRoot(transferRoot);
    if (storeIsTemp) {
      cleanupTempStore(resolvedStore);
    }
    if (session.currentSendRoot === transferRoot) {
      session.currentSendRoot = null;
    }
    if (session.currentSendStore === resolvedStore) {
      session.currentSendStore = null;
    }
  });

  return { started: true, cliPath: resolvedCli };
});

ipcMain.handle('stop-send', async (event) => {
  const session = getSessionFromSender(event.sender);
  if (!session.sendProcess) return { stopped: false };
  session.sendProcess.kill('SIGINT');
  return { stopped: true };
});

ipcMain.handle('start-receive', async (event, { cliPath, storeDir, ticket, fallbackTicket, outputPath, expectedSize }) => {
  const session = getSessionFromSender(event.sender);
  if (session.receiveProcess) throw new Error('Receive process already running in this window');
  if (!ticket) throw new Error('Ticket is required');
  if (!outputPath) throw new Error('Output path is required');

  const resolvedCli = resolveCliPath(cliPath);
  sendToSession(session, 'process-log', { channel: 'receive', message: `CLI: ${resolvedCli}`, isError: false });
  const env = { ...process.env };
  session.receiveStopRequested = false;
  session.receivePoisoned = false;
  if (storeDir) {
    env.ORBITXFER_STORE_DIR = storeDir;
    session.currentReceiveStore = storeDir;
  } else if (resumeMode) {
    const outputDir = path.dirname(outputPath);
    const ticketKey = crypto.createHash('sha256').update(ticket).digest('hex').slice(0, 12);
    const resumeRoot = path.join(outputDir, '.orbitxfer-store');
    const resumeStore = path.join(resumeRoot, ticketKey);
    env.ORBITXFER_STORE_DIR = resumeStore;
    session.currentReceiveStore = resumeStore;
  } else {
    delete env.ORBITXFER_STORE_DIR;
    session.currentReceiveStore = null;
  }
  if (session.currentReceiveStore) {
    fs.mkdirSync(session.currentReceiveStore, { recursive: true });
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
    const proc = spawn(resolvedCli, ['receive', ticketValue, outputPath], { env });
    session.receiveProcess = proc;
    streamProcess(session, proc, 'receive', {
      suppressExit: true,
      onExit: (code) => {
        if (session.receiveProcess === proc) {
          session.receiveProcess = null;
        }
        if (session.receiveStopRequested) {
          session.receiveStopRequested = false;
          sendToSession(session, 'process-exit', { channel: 'receive', code });
          return;
        }
        if (code === 0) {
          sendToSession(session, 'process-exit', { channel: 'receive', code });
          return;
        }
        if (!attemptedFallback && secondaryTicket) {
          attemptedFallback = true;
          if (session.receivePoisoned && session.currentReceiveStore) {
            try {
              fs.rmSync(session.currentReceiveStore, { recursive: true, force: true });
              fs.mkdirSync(session.currentReceiveStore, { recursive: true });
              appendDebug(`window=${session.id} cleanup_receive_store_poisoned ${session.currentReceiveStore}`);
            } catch (_) {
              // ignore cleanup failures
            }
            session.receivePoisoned = false;
          }
          sendToSession(session, 'process-event', {
            channel: 'receive',
            payload: { type: 'download_retry', message: 'Direct connection failed. Trying relay…' }
          });
          sendToSession(session, 'process-log', {
            channel: 'receive',
            message: 'Direct connection failed. Retrying via relay ticket.',
            isError: true
          });
          startAttempt(secondaryTicket);
          return;
        }
        if (session.receivePoisoned && session.currentReceiveStore) {
          const poisonedStore = session.currentReceiveStore;
          fs.promises
            .rm(poisonedStore, { recursive: true, force: true })
            .then(() => appendDebug(`window=${session.id} cleanup_receive_store_poisoned ${poisonedStore}`))
            .catch(() => {});
          session.currentReceiveStore = null;
          session.receivePoisoned = false;
        }
        sendToSession(session, 'process-exit', { channel: 'receive', code });
      }
    });
  };

  startAttempt(primaryTicket);

  return { started: true, cliPath: resolvedCli };
});

ipcMain.handle('stop-receive', async (event) => {
  const session = getSessionFromSender(event.sender);
  if (!session.receiveProcess) return { stopped: false };
  session.receiveStopRequested = true;
  session.receiveProcess.kill('SIGINT');
  return { stopped: true };
});

ipcMain.handle('cleanup-transfers', async () => {
  await cleanupStaleTransfers();
  return { ok: true };
});

ipcMain.handle('cleanup-receive-store', async (event) => {
  const session = getSessionFromSender(event.sender);
  if (session.currentReceiveStore) {
    const store = session.currentReceiveStore;
    try {
      await fs.promises.rm(store, { recursive: true, force: true });
      appendDebug(`window=${session.id} cleanup_receive_store ${store}`);
    } catch (_) {
      // ignore cleanup failures
    }
    if (session.currentReceiveStore === store) {
      session.currentReceiveStore = null;
    }
  }
  return { ok: true };
});
