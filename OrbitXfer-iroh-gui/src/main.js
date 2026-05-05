const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isMac = process.platform === 'darwin';
const windowSessions = new Map();
const stagedFiles = new Set();
const transferRoots = new Set();
const tempStores = new Set();
const resumeMode = (process.env.ORBITXFER_RESUME_MODE || '1') === '1';
const quitWarningMessage = 'A transfer is in progress. Quitting now will abort the transfer';
const RESUME_STATE_VERSION = 1;

let resumeState = { send: null, receive: null };
let resumeStateWriteTimer = null;
let quitConfirmed = false;
let quitPromptPending = false;

function cloneState(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function resumeStatePath() {
  return path.join(app.getPath('userData'), 'resume-state.json');
}

function getResumeSnapshot() {
  return {
    send: cloneState(resumeState.send),
    receive: cloneState(resumeState.receive)
  };
}

function normalizePath(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(value);
}

function managedReceiveStorePath(outputPath) {
  const resolvedOutputPath = normalizePath(outputPath);
  if (!resolvedOutputPath) return '';
  const outputDir = path.dirname(resolvedOutputPath);
  const outputName = path.basename(resolvedOutputPath) || 'download';
  return path.join(outputDir, `${outputName}.orbitxfer-pieces`);
}

function normalizeTicket(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeForLog(value, lead = 18, tail = 10) {
  if (!value) return '—';
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

function shareTokenV1(ticket, filename, size) {
  if (!ticket) return '';
  const payload = { ticket };
  if (filename) payload.name = filename;
  if (typeof size === 'number' && Number.isFinite(size)) {
    payload.size = size;
  }
  const json = JSON.stringify(payload);
  return `ox1:${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function shareTokenV2(directTicket, relayTicket, filename, size) {
  if (!directTicket || !relayTicket) return '';
  const payload = { direct: directTicket, relay: relayTicket };
  if (filename) payload.name = filename;
  if (typeof size === 'number' && Number.isFinite(size)) {
    payload.size = size;
  }
  const json = JSON.stringify(payload);
  return `ox2:${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function buildShareTokenFromState(state) {
  if (!state) return '';
  const size = typeof state.fileSize === 'number' ? state.fileSize : state.ticketTotal;
  if (state.sendMode === 'direct') {
    return state.directTicket ? shareTokenV1(state.directTicket, state.fileName, size) : '';
  }
  if (state.directTicket && state.relayTicket) {
    return shareTokenV2(state.directTicket, state.relayTicket, state.fileName, size);
  }
  const baseTicket = state.ticket || state.fullTicket || state.directTicket || state.relayTicket;
  return baseTicket ? shareTokenV1(baseTicket, state.fileName, size) : '';
}

function flushResumeState() {
  try {
    fs.mkdirSync(path.dirname(resumeStatePath()), { recursive: true });
    fs.writeFileSync(
      resumeStatePath(),
      `${JSON.stringify(getResumeSnapshot(), null, 2)}\n`,
      'utf8'
    );
  } catch (_) {
    // ignore persistence failures
  }
}

function scheduleResumeStateWrite(immediate = false) {
  if (resumeStateWriteTimer) {
    clearTimeout(resumeStateWriteTimer);
    resumeStateWriteTimer = null;
  }
  if (immediate) {
    flushResumeState();
    return;
  }
  resumeStateWriteTimer = setTimeout(() => {
    resumeStateWriteTimer = null;
    flushResumeState();
  }, 150);
}

function loadResumeState() {
  try {
    const raw = fs.readFileSync(resumeStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    resumeState = {
      send: parsed?.send && typeof parsed.send === 'object' ? parsed.send : null,
      receive: parsed?.receive && typeof parsed.receive === 'object' ? parsed.receive : null
    };
  } catch (_) {
    resumeState = { send: null, receive: null };
  }
}

function sendResumePath(state) {
  return state?.transferRoot || '';
}

function receiveResumePath(state) {
  return state?.storeManaged ? state.storeDir || '' : '';
}

function isSendResumePathEqual(a, b) {
  return sendResumePath(a) && sendResumePath(a) === sendResumePath(b);
}

function isReceiveResumePathEqual(a, b) {
  return receiveResumePath(a) && receiveResumePath(a) === receiveResumePath(b);
}

function cleanupManagedReceiveStore(storeDir) {
  if (!storeDir) return;
  fs.promises.rm(storeDir, { recursive: true, force: true }).catch(() => {});
}

function cleanupStoredResumeResources(kind, state) {
  if (!state) return;
  if (kind === 'send') {
    const transferRoot = state.transferRoot;
    if (
      transferRoot &&
      ![...windowSessions.values()].some((session) => session.currentSendRoot === transferRoot)
    ) {
      cleanupTransferRoot(transferRoot);
    }
    return;
  }
  if (state.storeManaged && state.storeDir) {
    if (
      [...windowSessions.values()].some((session) => session.currentReceiveStore === state.storeDir)
    ) {
      return;
    }
    cleanupManagedReceiveStore(state.storeDir);
  }
}

function refreshApplicationMenu() {
  if (!app.isReady()) return;
  Menu.setApplicationMenu(buildApplicationMenu());
}

function emitResumeState() {
  const payload = getResumeSnapshot();
  for (const session of windowSessions.values()) {
    sendToSession(session, 'resume-state', payload);
  }
}

function saveResumeEntry(kind, value, options = {}) {
  const previous = resumeState[kind];
  const next = value ? { ...cloneState(value), version: RESUME_STATE_VERSION } : null;
  const availabilityChanged = Boolean(previous) !== Boolean(next);
  resumeState[kind] = next;
  scheduleResumeStateWrite(Boolean(options.immediate));
  if (previous) {
    const samePath =
      kind === 'send'
        ? isSendResumePathEqual(previous, next)
        : isReceiveResumePathEqual(previous, next);
    if (!samePath) {
      cleanupStoredResumeResources(kind, previous);
    }
  }
  if (availabilityChanged || options.broadcast) {
    refreshApplicationMenu();
  }
  if (options.broadcast) {
    emitResumeState();
  }
}

function clearResumeEntry(kind, options = {}) {
  const previous = resumeState[kind];
  if (!previous) return;
  resumeState[kind] = null;
  scheduleResumeStateWrite(Boolean(options.immediate));
  if (options.cleanup !== false) {
    cleanupStoredResumeResources(kind, previous);
  }
  refreshApplicationMenu();
  if (options.broadcast) {
    emitResumeState();
  }
}

function findMatchingReceiveResume({ ticket, outputPath, resumeLast }) {
  const saved = resumeState.receive;
  if (!saved) return null;
  if (resumeLast) return saved;
  if (!normalizeTicket(ticket) || !normalizePath(outputPath)) return null;
  if (normalizeTicket(saved.ticket) !== normalizeTicket(ticket)) return null;
  if (normalizePath(saved.outputPath) !== normalizePath(outputPath)) return null;
  return saved;
}

function getTargetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) || null;
}

function dispatchMenuAction(action) {
  let target = getTargetWindow();
  if (!target) {
    target = openTransferWindow(null);
  }
  const deliver = () => {
    if (!target || target.isDestroyed()) return;
    target.webContents.send('menu-action', { action });
  };
  if (target.webContents.isLoadingMainFrame()) {
    target.webContents.once('did-finish-load', deliver);
  } else {
    deliver();
  }
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

function activeTransferRoots() {
  const keep = new Set(transferRoots);
  for (const session of windowSessions.values()) {
    if (session.sendProcess && session.currentSendRoot) {
      keep.add(session.currentSendRoot);
    }
  }
  if (resumeState.send?.transferRoot) {
    keep.add(resumeState.send.transferRoot);
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
    sendStopRequested: false,
    receiveStopRequested: false,
    preserveSendStateOnExit: false,
    preserveReceiveStateOnExit: false,
    streamBuffers: new Map(),
    currentSendRoot: null,
    currentSendStore: null,
    currentSendStoreManaged: false,
    currentReceiveStore: null,
    currentReceiveStoreManaged: false,
    receivePoisoned: false,
    sendState: null,
    receiveState: null,
    closePromptPending: false,
    allowCloseOnce: false
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

function hasActiveTransfer(session) {
  return Boolean(session?.sendProcess || session?.receiveProcess);
}

function activeTransferWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    const session = windowSessions.get(focused.webContents.id);
    if (hasActiveTransfer(session)) {
      return focused;
    }
  }
  for (const session of windowSessions.values()) {
    if (hasActiveTransfer(session) && session.window && !session.window.isDestroyed()) {
      return session.window;
    }
  }
  return null;
}

async function confirmQuitWarning(window) {
  const result = await dialog.showMessageBox(window || null, {
    type: 'warning',
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: quitWarningMessage
  });
  return result.response === 1;
}

function destroySession(session) {
  if (!session) return;
  stopChildProcess(session.sendProcess);
  stopChildProcess(session.receiveProcess);
  if (
    !session.sendProcess &&
    session.currentSendRoot &&
    !session.preserveSendStateOnExit &&
    session.currentSendRoot !== resumeState.send?.transferRoot
  ) {
    const root = session.currentSendRoot;
    session.currentSendRoot = null;
    cleanupTransferRoot(root);
  }
  if (
    !session.sendProcess &&
    session.currentSendStore &&
    tempStores.has(session.currentSendStore) &&
    !session.preserveSendStateOnExit
  ) {
    const store = session.currentSendStore;
    session.currentSendStore = null;
    cleanupTempStore(store);
  }
  if (
    !session.receiveProcess &&
    session.currentReceiveStore &&
    session.currentReceiveStoreManaged &&
    !session.preserveReceiveStateOnExit &&
    session.currentReceiveStore !== resumeState.receive?.storeDir
  ) {
    cleanupManagedReceiveStore(session.currentReceiveStore);
    session.currentReceiveStore = null;
  }
  session.window = null;
}

function nextWindowBounds(sourceWindow = BrowserWindow.getFocusedWindow()) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return {};
  const baseBounds = sourceWindow.getBounds();
  return {
    x: baseBounds.x + 36,
    y: baseBounds.y + 36
  };
}

function buildApplicationMenu() {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Transfer Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => openTransferWindow()
        },
        {
          label: 'Resume Last Send Transfer',
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: Boolean(resumeState.send),
          click: () => dispatchMenuAction('resume-last-send')
        },
        {
          label: 'Resume Last Receive Transfer',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: Boolean(resumeState.receive),
          click: () => dispatchMenuAction('resume-last-receive')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' }
            ]
          : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' }
            ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    ...(isMac
      ? [{ role: 'windowMenu' }]
      : [{
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'close' }
          ]
        }])
  ];

  return Menu.buildFromTemplate(template);
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

  window.webContents.on('did-finish-load', () => {
    sendToSession(session, 'resume-state', getResumeSnapshot());
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('close', (event) => {
    if (quitConfirmed) return;
    if (session.allowCloseOnce) {
      session.allowCloseOnce = false;
      return;
    }
    if (!hasActiveTransfer(session)) return;
    if (session.closePromptPending) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    session.closePromptPending = true;
    confirmQuitWarning(window)
      .then((confirmed) => {
        session.closePromptPending = false;
        if (!confirmed) return;
        if (session.sendProcess && session.sendState) {
          session.preserveSendStateOnExit = true;
          saveResumeEntry('send', session.sendState, { immediate: true, broadcast: true });
        }
        if (session.receiveProcess && session.receiveState) {
          session.preserveReceiveStateOnExit = true;
          saveResumeEntry('receive', session.receiveState, { immediate: true, broadcast: true });
        }
        session.allowCloseOnce = true;
        window.close();
      })
      .catch(() => {
        session.closePromptPending = false;
      });
  });

  window.on('closed', () => {
    destroySession(session);
    windowSessions.delete(session.id);
  });

  return window;
}

function openTransferWindow(sourceWindow = BrowserWindow.getFocusedWindow()) {
  return createWindow(nextWindowBounds(sourceWindow));
}

app.whenReady().then(() => {
  loadResumeState();
  Menu.setApplicationMenu(buildApplicationMenu());
  openTransferWindow(null);
  cleanupStaleTransfers();
  cleanupStaleTempStores();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openTransferWindow(null);
  });
});

app.on('before-quit', (event) => {
  if (quitConfirmed) {
    scheduleResumeStateWrite(true);
    return;
  }
  const warningWindow = activeTransferWindow();
  if (!warningWindow) {
    scheduleResumeStateWrite(true);
    return;
  }
  if (quitPromptPending) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  quitPromptPending = true;
  confirmQuitWarning(warningWindow)
    .then((confirmed) => {
      quitPromptPending = false;
      if (!confirmed) return;
      quitConfirmed = true;
      for (const session of windowSessions.values()) {
        if (session.sendProcess && session.sendState) {
          session.preserveSendStateOnExit = true;
          saveResumeEntry('send', session.sendState, { immediate: true, broadcast: true });
        }
        if (session.receiveProcess && session.receiveState) {
          session.preserveReceiveStateOnExit = true;
          saveResumeEntry('receive', session.receiveState, { immediate: true, broadcast: true });
        }
      }
      app.quit();
    })
    .catch(() => {
      quitPromptPending = false;
    });
});

app.on('will-quit', () => {
  scheduleResumeStateWrite(true);
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

ipcMain.handle('get-resume-state', async () => getResumeSnapshot());

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

function updateSendState(session, patch, options = {}) {
  const next = {
    ...(session.sendState || {}),
    ...patch,
    kind: 'send',
    version: RESUME_STATE_VERSION,
    lastUpdatedAt: new Date().toISOString()
  };
  const shareToken = buildShareTokenFromState(next);
  if (shareToken) {
    next.shareToken = shareToken;
  }
  session.sendState = next;
  saveResumeEntry('send', next, options);
}

function updateReceiveState(session, patch, options = {}) {
  const next = {
    ...(session.receiveState || {}),
    ...patch,
    kind: 'receive',
    version: RESUME_STATE_VERSION,
    lastUpdatedAt: new Date().toISOString()
  };
  session.receiveState = next;
  saveResumeEntry('receive', next, options);
}

function recordProcessEventState(session, channel, payload) {
  if (!payload || typeof payload !== 'object') return;

  if (channel === 'send') {
    switch (payload.type) {
      case 'staging_start':
        updateSendState(session, {
          ticketBytes: 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          phase: 'preparing'
        });
        break;
      case 'staging_progress':
        updateSendState(session, {
          ticketBytes: payload.bytes ?? session.sendState?.ticketBytes ?? 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          phase: 'preparing'
        });
        break;
      case 'staging_complete':
      case 'staging_skipped':
        updateSendState(session, {
          ticketBytes: payload.total ?? session.sendState?.ticketBytes ?? 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          phase: 'hashing'
        });
        break;
      case 'ticket_hashing_size':
        updateSendState(session, {
          fileSize: payload.total ?? session.sendState?.fileSize,
          ticketBytes: 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          uploadTotal: payload.total ?? session.sendState?.uploadTotal
        });
        break;
      case 'ticket_hashing_progress':
        updateSendState(session, {
          ticketBytes: payload.bytes ?? session.sendState?.ticketBytes ?? 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          phase: 'hashing'
        });
        break;
      case 'ticket_variants':
        updateSendState(session, {
          directTicket: payload.direct || '',
          relayTicket: payload.relay || '',
          fullTicket: payload.full || ''
        }, { immediate: true });
        break;
      case 'ticket_created':
        updateSendState(session, {
          ticket: payload.ticket || session.sendState?.ticket || '',
          fileSize: payload.total ?? session.sendState?.fileSize,
          ticketBytes: payload.total ?? session.sendState?.ticketBytes ?? 0,
          ticketTotal: payload.total ?? session.sendState?.ticketTotal,
          uploadTotal: payload.total ?? session.sendState?.uploadTotal,
          phase: 'waiting'
        }, { immediate: true, broadcast: true });
        break;
      case 'receiver_connected':
        updateSendState(session, { phase: 'uploading' }, { immediate: true });
        break;
      case 'upload_started':
        updateSendState(session, {
          phase: 'uploading',
          uploadTotal: payload.total ?? session.sendState?.uploadTotal
        });
        break;
      case 'upload_progress':
        updateSendState(session, {
          phase: 'uploading',
          uploadBytes: payload.bytes ?? session.sendState?.uploadBytes ?? 0,
          uploadTotal: payload.total ?? session.sendState?.uploadTotal
        });
        break;
      case 'upload_complete':
        updateSendState(session, {
          phase: 'complete',
          uploadBytes: session.sendState?.uploadTotal ?? session.sendState?.fileSize ?? 0
        }, { immediate: true });
        break;
      case 'upload_aborted':
        updateSendState(session, { phase: 'aborted' }, { immediate: true });
        break;
      case 'error':
        updateSendState(session, {
          phase: 'error',
          lastError: payload.message || 'Send error.'
        }, { immediate: true });
        break;
      default:
        break;
    }
    return;
  }

  switch (payload.type) {
    case 'download_size':
      updateReceiveState(session, {
        expectedSize: payload.total ?? session.receiveState?.expectedSize,
        downloadTotal: payload.total ?? session.receiveState?.downloadTotal,
        exportTotal: payload.total ?? session.receiveState?.exportTotal
      });
      break;
    case 'download_resume_state':
      updateReceiveState(session, {
        phase: 'downloading',
        downloadBytes: payload.bytes ?? session.receiveState?.downloadBytes ?? 0,
        downloadTotal: payload.total ?? session.receiveState?.downloadTotal
      }, { immediate: true });
      break;
    case 'download_started':
      updateReceiveState(session, {
        phase: 'downloading',
        downloadTotal: payload.total ?? session.receiveState?.downloadTotal
      });
      break;
    case 'download_progress':
      updateReceiveState(session, {
        phase: 'downloading',
        downloadBytes: payload.bytes ?? session.receiveState?.downloadBytes ?? 0,
        downloadTotal: payload.total ?? session.receiveState?.downloadTotal
      });
      break;
    case 'download_complete':
      updateReceiveState(session, {
        phase: 'exporting',
        downloadBytes: session.receiveState?.downloadTotal ?? session.receiveState?.expectedSize ?? 0
      }, { immediate: true });
      break;
    case 'export_started':
      updateReceiveState(session, {
        phase: 'exporting',
        exportTotal: payload.total ?? session.receiveState?.exportTotal
      });
      break;
    case 'export_size':
      updateReceiveState(session, {
        exportTotal: payload.total ?? session.receiveState?.exportTotal
      });
      break;
    case 'export_progress':
      updateReceiveState(session, {
        phase: 'exporting',
        exportBytes: payload.bytes ?? session.receiveState?.exportBytes ?? 0,
        exportTotal: payload.total ?? session.receiveState?.exportTotal
      });
      break;
    case 'export_complete':
      updateReceiveState(session, {
        phase: 'complete',
        exportBytes: session.receiveState?.exportTotal ?? session.receiveState?.expectedSize ?? 0
      }, { immediate: true });
      break;
    case 'error':
      updateReceiveState(session, {
        phase: 'error',
        lastError: payload.message || 'Receive error.'
      }, { immediate: true });
      break;
    default:
      break;
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
        recordProcessEventState(session, channel, parsed);
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

ipcMain.handle('start-send', async (event, { cliPath, storeDir, filePath, sendMode, resumeLast }) => {
  const session = getSessionFromSender(event.sender);
  if (session.sendProcess) throw new Error('Send process already running in this window');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File path is invalid');

  const resolvedCli = resolveCliPath(cliPath);
  const resolvedFilePath = normalizePath(filePath);
  const selectedStoreDir = storeDir ? normalizePath(storeDir) : '';
  const savedResume = resumeLast ? resumeState.send : null;
  const fileStats = await fs.promises.stat(resolvedFilePath);
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
  if (!selectedStoreDir) {
    transferRoot = savedResume?.transferRoot || createTransferRoot();
    transferRoots.add(transferRoot);
    session.currentSendRoot = transferRoot;
    if (stageMode !== 'direct' && stageMode !== 'none') {
      stagingRoot = path.join(transferRoot, 'staging');
    }
  }
  const resolvedStore = selectedStoreDir || path.join(transferRoot, 'store');
  session.currentSendStore = resolvedStore;
  session.currentSendStoreManaged = !selectedStoreDir;
  session.sendStopRequested = false;
  session.preserveSendStateOnExit = false;
  fs.mkdirSync(resolvedStore, { recursive: true });
  env.ORBITXFER_STORE_DIR = resolvedStore;
  env.ORBITXFER_IMPORT_MODE = 'try_reference';
  session.sendState = {
    ...(savedResume || {}),
    kind: 'send',
    version: RESUME_STATE_VERSION,
    filePath: resolvedFilePath,
    fileName: path.basename(resolvedFilePath),
    fileSize: fileStats.size,
    sendMode,
    ticketMode,
    ticketTotal: savedResume?.ticketTotal ?? fileStats.size,
    uploadTotal: savedResume?.uploadTotal ?? fileStats.size,
    transferRoot,
    storeDir: resolvedStore,
    storeManaged: !selectedStoreDir,
    phase: 'starting',
    startedAt: savedResume?.startedAt || new Date().toISOString()
  };
  session.sendState.shareToken = session.sendState.shareToken || buildShareTokenFromState(session.sendState);
  saveResumeEntry('send', session.sendState, { immediate: true, broadcast: true });
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
  proc.on('close', (code) => {
    if (session.sendProcess === proc) {
      session.sendProcess = null;
    }
    const keepForResume = session.preserveSendStateOnExit || (!session.sendStopRequested && code !== 0);
    if (keepForResume && session.sendState) {
      updateSendState(session, { phase: 'interrupted' }, { immediate: true, broadcast: true });
    } else {
      clearResumeEntry('send', { immediate: true, broadcast: true, cleanup: false });
      session.sendState = null;
    }
    cleanupStagedFile(stagedPath);
    if (!keepForResume && transferRoot) {
      cleanupTransferRoot(transferRoot);
    }
    if (session.currentSendRoot === transferRoot) {
      session.currentSendRoot = null;
    }
    if (session.currentSendStore === resolvedStore) {
      session.currentSendStore = null;
    }
    session.currentSendStoreManaged = false;
    session.preserveSendStateOnExit = false;
    session.sendStopRequested = false;
  });

  return { started: true, cliPath: resolvedCli };
});

ipcMain.handle('stop-send', async (event) => {
  const session = getSessionFromSender(event.sender);
  if (!session.sendProcess) return { stopped: false };
  session.sendStopRequested = true;
  session.preserveSendStateOnExit = false;
  session.sendProcess.kill('SIGINT');
  return { stopped: true };
});

ipcMain.handle('start-receive', async (event, { cliPath, storeDir, ticket, fallbackTicket, outputPath, expectedSize, ticketInput, resumeLast }) => {
  const session = getSessionFromSender(event.sender);
  if (session.receiveProcess) throw new Error('Receive process already running in this window');
  if (!ticket) throw new Error('Ticket is required');
  if (!outputPath) throw new Error('Output path is required');

  const resolvedCli = resolveCliPath(cliPath);
  const resolvedOutputPath = normalizePath(outputPath);
  const selectedStoreDir = storeDir ? normalizePath(storeDir) : '';
  const matchedResume = findMatchingReceiveResume({ ticket, outputPath: resolvedOutputPath, resumeLast });
  sendToSession(session, 'process-log', { channel: 'receive', message: `CLI: ${resolvedCli}`, isError: false });
  const env = { ...process.env };
  session.receiveStopRequested = false;
  session.preserveReceiveStateOnExit = false;
  session.receivePoisoned = false;
  if (selectedStoreDir) {
    env.ORBITXFER_STORE_DIR = selectedStoreDir;
    session.currentReceiveStore = selectedStoreDir;
    session.currentReceiveStoreManaged = false;
  } else if (matchedResume?.storeDir) {
    env.ORBITXFER_STORE_DIR = matchedResume.storeDir;
    session.currentReceiveStore = matchedResume.storeDir;
    session.currentReceiveStoreManaged = Boolean(matchedResume.storeManaged);
  } else if (resumeMode) {
    const resumeStore = managedReceiveStorePath(resolvedOutputPath);
    env.ORBITXFER_STORE_DIR = resumeStore;
    session.currentReceiveStore = resumeStore;
    session.currentReceiveStoreManaged = true;
  } else {
    delete env.ORBITXFER_STORE_DIR;
    session.currentReceiveStore = null;
    session.currentReceiveStoreManaged = false;
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
  sendToSession(session, 'process-log', {
    channel: 'receive',
    message: `Ticket: ${summarizeForLog(primaryTicket)}${secondaryTicket ? ' (relay fallback available)' : ''}`,
    isError: false
  });
  sendToSession(session, 'process-log', {
    channel: 'receive',
    message: `Destination: ${resolvedOutputPath}`,
    isError: false
  });
  if (session.currentReceiveStore) {
    sendToSession(session, 'process-log', {
      channel: 'receive',
      message: `Temporary transfer data: ${session.currentReceiveStore}${session.currentReceiveStoreManaged ? ' (managed)' : ''}`,
      isError: false
    });
  }
  if (matchedResume) {
    sendToSession(session, 'process-log', {
      channel: 'receive',
      message: 'Matched saved resume state for this token and destination.',
      isError: false
    });
  }
  session.receiveState = {
    ...(matchedResume || {}),
    kind: 'receive',
    version: RESUME_STATE_VERSION,
    tokenInput: normalizeTicket(ticketInput) || matchedResume?.tokenInput || primaryTicket,
    ticket: primaryTicket,
    fallbackTicket: secondaryTicket,
    outputPath: resolvedOutputPath,
    expectedSize: typeof expectedSize === 'number' && Number.isFinite(expectedSize)
      ? Math.floor(expectedSize)
      : matchedResume?.expectedSize ?? null,
    downloadTotal: typeof expectedSize === 'number' && Number.isFinite(expectedSize)
      ? Math.floor(expectedSize)
      : matchedResume?.downloadTotal ?? null,
    exportTotal: typeof expectedSize === 'number' && Number.isFinite(expectedSize)
      ? Math.floor(expectedSize)
      : matchedResume?.exportTotal ?? null,
    storeDir: session.currentReceiveStore,
    storeManaged: session.currentReceiveStoreManaged,
    phase: 'starting',
    startedAt: matchedResume?.startedAt || new Date().toISOString()
  };
  saveResumeEntry('receive', session.receiveState, { immediate: true, broadcast: true });

  const startAttempt = (ticketValue) => {
    const proc = spawn(resolvedCli, ['receive', ticketValue, resolvedOutputPath], { env });
    session.receiveProcess = proc;
    streamProcess(session, proc, 'receive', {
      suppressExit: true,
      onExit: (code) => {
        if (session.receiveProcess === proc) {
          session.receiveProcess = null;
        }
        const keepForResume = session.preserveReceiveStateOnExit || (!session.receiveStopRequested && code !== 0);
        if (session.receiveStopRequested) {
          clearResumeEntry('receive', { immediate: true, broadcast: true, cleanup: false });
          if (session.currentReceiveStoreManaged && session.currentReceiveStore) {
            cleanupManagedReceiveStore(session.currentReceiveStore);
          }
          session.currentReceiveStore = null;
          session.currentReceiveStoreManaged = false;
          session.receiveState = null;
          session.receiveStopRequested = false;
          sendToSession(session, 'process-exit', { channel: 'receive', code });
          return;
        }
        if (code === 0) {
          clearResumeEntry('receive', { immediate: true, broadcast: true, cleanup: false });
          if (session.currentReceiveStoreManaged && session.currentReceiveStore) {
            cleanupManagedReceiveStore(session.currentReceiveStore);
          }
          session.currentReceiveStore = null;
          session.currentReceiveStoreManaged = false;
          session.receiveState = null;
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
          session.currentReceiveStoreManaged = false;
          session.receivePoisoned = false;
        }
        if (keepForResume && session.receiveState) {
          updateReceiveState(session, { phase: 'interrupted' }, { immediate: true, broadcast: true });
        } else {
          clearResumeEntry('receive', { immediate: true, broadcast: true, cleanup: false });
          session.receiveState = null;
        }
        session.receiveStopRequested = false;
        session.preserveReceiveStateOnExit = false;
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
  session.preserveReceiveStateOnExit = false;
  session.receiveProcess.kill('SIGINT');
  return { stopped: true };
});

ipcMain.handle('cleanup-transfers', async () => {
  await cleanupStaleTransfers();
  return { ok: true };
});

ipcMain.handle('cleanup-receive-store', async (event) => {
  const session = getSessionFromSender(event.sender);
  if (session.currentReceiveStore && session.currentReceiveStoreManaged) {
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
