const { ipcRenderer } = require('electron');
const path = require('path');

let sendRunning = false;
let receiveRunning = false;
let sendFilename = '';
let receiveFilenameHint = '';
let currentTicket = '';
let currentTicketDirect = '';
let currentTicketRelay = '';
let currentTicketFull = '';
let currentShareToken = '';
let sendFileSize = null;
let receiveExpectedSize = null;
let sendConnectionStart = null;
let receiveConnectionStart = null;
let sendCompleted = false;
let receiveCompleted = false;
let sendSpeedBps = null;
let receiveSpeedBps = null;

const speedSamples = {
  sendUpload: [],
  receiveDownload: []
};

const ticketRegex = /receive\s+(\S+)/;
const ticketPrefix = /^blob/i;
const tokenPrefix = /^ox[12]:/i;
const progressState = {
  sendTicketTotal: null,
  sendUploadTotal: null,
  receiveDownloadTotal: null,
  receiveExportTotal: null
};

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 MB/s';
  const mbps = bytesPerSec / (1024 * 1024);
  return `${mbps.toFixed(mbps >= 10 ? 0 : 1)} MB/s`;
}

function formatRatePerHour(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 /hour';
  const bytesPerHour = bytesPerSec * 3600;
  return `${formatBytes(bytesPerHour)}/hour`;
}

function updateRollingSpeed(sampleKey, bytes) {
  const now = performance.now();
  const samples = speedSamples[sampleKey];
  if (!samples) return null;
  samples.push({ t: now, bytes });
  while (samples.length > 1 && now - samples[0].t > 4000) {
    samples.shift();
  }
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  const db = last.bytes - first.bytes;
  if (db <= 0) return null;
  return db / dt;
}

function getSendMode() {
  const selected = document.querySelector('input[name="sendMode"]:checked');
  return selected ? selected.value : 'auto';
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu');
});

function setStatus(id, message, type) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = `status status-${type}`;
}

function appendLog(targetId, message, isError) {
  const box = document.getElementById(targetId);
  const line = document.createElement('div');
  line.className = isError ? 'log-line log-error' : 'log-line';
  line.textContent = message.trim();
  if (line.textContent) {
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function extractBlobTicket(value) {
  if (!value) return '';
  const match = value.match(/blob[0-9a-z]+/i);
  return match ? match[0] : '';
}

function encodeToken(ticket, filename, size) {
  if (!ticketPrefix.test(ticket)) return '';
  const payload = { ticket };
  if (filename) payload.name = filename;
  if (typeof size === 'number' && Number.isFinite(size)) {
    payload.size = size;
  }
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `ox1:${b64}`;
}

function encodeTokenV2(directTicket, relayTicket, filename, size) {
  if (!ticketPrefix.test(directTicket) || !ticketPrefix.test(relayTicket)) return '';
  const payload = { direct: directTicket, relay: relayTicket };
  if (filename) payload.name = filename;
  if (typeof size === 'number' && Number.isFinite(size)) {
    payload.size = size;
  }
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `ox2:${b64}`;
}

function decodeToken(token) {
  if (!tokenPrefix.test(token)) return null;
  try {
    const version = token.slice(0, 3).toLowerCase();
    const b64 = token.slice(4);
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    if (version === 'ox2') {
      const direct = typeof data.direct === 'string' ? data.direct : '';
      const relay = typeof data.relay === 'string' ? data.relay : '';
      const primary = direct || relay;
      if (!primary) return null;
      return {
        ticket: primary,
        fallbackTicket: direct && relay ? relay : '',
        filename: typeof data.name === 'string' ? data.name : '',
        size: typeof data.size === 'number' ? data.size : null
      };
    }
    if (typeof data.ticket !== 'string') return null;
    return {
      ticket: data.ticket,
      fallbackTicket: '',
      filename: typeof data.name === 'string' ? data.name : '',
      size: typeof data.size === 'number' ? data.size : null
    };
  } catch (_) {
    return null;
  }
}

function buildShareToken() {
  const size = sendFileSize ?? progressState.sendTicketTotal;
  const mode = getSendMode();
  if (mode === 'direct') {
    return currentTicketDirect ? encodeToken(currentTicketDirect, sendFilename, size) : '';
  }
  if (currentTicketDirect && currentTicketRelay) {
    return encodeTokenV2(currentTicketDirect, currentTicketRelay, sendFilename, size);
  }
  const baseTicket = currentTicket || currentTicketDirect || currentTicketRelay;
  return baseTicket ? encodeToken(baseTicket, sendFilename, size) : '';
}

function extractBlobTicketFromLog() {
  const logEl = document.getElementById('sendLog');
  if (!logEl) return '';
  const text = logEl.textContent || '';
  const matches = text.match(/blob[0-9a-z]+/gi);
  if (!matches || matches.length === 0) return '';
  return matches[matches.length - 1];
}

function parseTicketInput(rawValue) {
  const raw = (rawValue || '').trim();
  if (!raw) return { ticket: '', fallbackTicket: '', filename: '', size: null };

  let ticket = raw;
  let fallbackTicket = '';
  let filename = '';
  let size = null;

  if (tokenPrefix.test(raw)) {
    const decoded = decodeToken(raw);
    if (decoded) return decoded;
  }

  if (raw.startsWith('orbitxfer://')) {
    try {
      const url = new URL(raw);
      const pathPart = url.pathname.replace(/^\/+/, '');
      if (url.hostname === 'share') {
        ticket = pathPart || '';
      } else if (url.hostname) {
        ticket = url.hostname;
      }
      filename = url.searchParams.get('name') || '';
      if (tokenPrefix.test(ticket)) {
        const decoded = decodeToken(ticket);
        if (decoded) return decoded;
      }
      if (!ticket) {
        ticket = extractBlobTicket(raw);
      }
      return { ticket, fallbackTicket, filename, size };
    } catch (_) {
      // Fall through to plain parsing.
    }
  }

  const pipeIdx = raw.indexOf('|');
  if (pipeIdx !== -1) {
    ticket = raw.slice(0, pipeIdx).trim();
    const meta = raw.slice(pipeIdx + 1).trim();
    if (meta.startsWith('name=')) {
      filename = decodeURIComponent(meta.slice(5));
    }
    return { ticket, fallbackTicket, filename, size };
  }

  if (tokenPrefix.test(ticket)) {
    const decoded = decodeToken(ticket);
    if (decoded) return decoded;
  }
  ticket = extractBlobTicket(ticket);
  return { ticket, fallbackTicket, filename, size };
}

function buildShareLink(token, filename) {
  if (!token) return '';
  if (tokenPrefix.test(token)) {
    try {
      const url = new URL('orbitxfer://share/');
      url.pathname = `/${token}`;
      return url.toString();
    } catch (_) {
      return token;
    }
  }
  if (!ticketPrefix.test(token)) return token;
  if (!filename) return token;
  try {
    const url = new URL('orbitxfer://share/');
    url.pathname = `/${token}`;
    url.searchParams.set('name', filename);
    return url.toString();
  } catch (_) {
    return token;
  }
}

function updateProgress(barId, textId, bytes, total) {
  const bar = document.getElementById(barId);
  const text = document.getElementById(textId);
  if (!bar || !text) return;

  const hasBytes = typeof bytes === 'number';
  const hasTotal = typeof total === 'number' && total > 0;
  const percent = hasBytes && hasTotal ? Math.min(100, (bytes / total) * 100) : null;

  bar.style.width = percent !== null ? `${percent.toFixed(1)}%` : hasBytes ? '8%' : '0%';

  const speedPrefix =
    barId === 'sendUploadBar'
      ? (sendSpeedBps ? `${formatSpeed(sendSpeedBps)} ` : '')
      : barId === 'receiveDownloadBar'
        ? (receiveSpeedBps ? `${formatSpeed(receiveSpeedBps)} ` : '')
        : '';

  if (hasBytes && hasTotal) {
    text.textContent = `${speedPrefix}${formatBytes(bytes)} / ${formatBytes(total)} (${percent.toFixed(1)}%)`;
  } else if (hasBytes) {
    text.textContent = `${speedPrefix}${formatBytes(bytes)} / —`;
  } else if (hasTotal) {
    text.textContent = `${speedPrefix}0 / ${formatBytes(total)}`;
  } else {
    text.textContent = speedPrefix ? `${speedPrefix}—` : '—';
  }
}

function resetSendUI() {
  progressState.sendTicketTotal = null;
  progressState.sendUploadTotal = null;
  sendConnectionStart = null;
  sendCompleted = false;
  sendSpeedBps = null;
  speedSamples.sendUpload = [];
  updateProgress('sendTicketBar', 'sendTicketProgress', null, null);
  updateProgress('sendUploadBar', 'sendUploadProgress', null, null);
  setStatus('sendTicketStatus', 'Idle.', 'info');
  setStatus('sendReceiverStatus', 'Waiting for receiver…', 'info');
  const shareEl = document.getElementById('shareTokenValue');
  if (shareEl) shareEl.textContent = '—';
  currentTicket = '';
  currentTicketDirect = '';
  currentTicketRelay = '';
  currentTicketFull = '';
  currentShareToken = '';
  const copyShare = document.getElementById('copyShareBtn');
  const copyRaw = document.getElementById('copyRawBtn');
  if (copyShare) copyShare.disabled = true;
  if (copyRaw) copyRaw.disabled = true;
  const stats = document.getElementById('sendCompleteStats');
  if (stats) {
    stats.classList.add('hidden');
    stats.setAttribute('hidden', 'hidden');
    stats.innerHTML = '';
  }
}

function resetReceiveUI() {
  progressState.receiveDownloadTotal = null;
  progressState.receiveExportTotal = null;
  receiveConnectionStart = null;
  receiveCompleted = false;
  receiveSpeedBps = null;
  speedSamples.receiveDownload = [];
  updateProgress('receiveDownloadBar', 'receiveDownloadProgress', null, null);
  updateProgress('receiveExportBar', 'receiveExportProgress', null, null);
  setStatus('receiveConnectStatus', 'Idle.', 'info');
  const stats = document.getElementById('receiveCompleteStats');
  if (stats) {
    stats.classList.add('hidden');
    stats.setAttribute('hidden', 'hidden');
    stats.innerHTML = '';
  }
}

function toggleLog(side) {
  const log = document.getElementById(side === 'send' ? 'sendLog' : 'receiveLog');
  const toggle = document.getElementById(side === 'send' ? 'sendLogToggle' : 'receiveLogToggle');
  if (!log || !toggle) return;
  const isOpen = log.classList.contains('log-expanded');
  if (isOpen) {
    log.classList.remove('log-expanded');
    log.classList.add('log-collapsed');
    toggle.textContent = '▸';
    toggle.setAttribute('aria-expanded', 'false');
  } else {
    log.classList.remove('log-collapsed');
    log.classList.add('log-expanded');
    toggle.textContent = '▾';
    toggle.setAttribute('aria-expanded', 'true');
  }
}

function renderCompletionStats(side, totalBytes, startTime, endTime) {
  if (!startTime || !endTime) return;
  const durationMs = endTime - startTime;
  const avgBps = totalBytes && durationMs > 0 ? (totalBytes / (durationMs / 1000)) : 0;
  const stats = document.getElementById(side === 'send' ? 'sendCompleteStats' : 'receiveCompleteStats');
  if (!stats) return;
  stats.innerHTML = [
    `Connected to peer for ${formatDuration(durationMs)}`,
    `Average transfer speed ${formatRatePerHour(avgBps)}`,
    `Total duration ${formatDuration(durationMs)}`
  ].map((line) => `<div>${line}</div>`).join('');
  stats.classList.remove('hidden');
  stats.removeAttribute('hidden');
}

async function pickFile() {
  const file = await ipcRenderer.invoke('select-file');
  if (file) document.getElementById('sendFile').value = file;
}

async function pickOutput() {
  const suggested =
    receiveFilenameHint ||
    document.getElementById('receiveOutput').value ||
    'downloaded-file';
  const output = await ipcRenderer.invoke('select-output', suggested);
  if (output) document.getElementById('receiveOutput').value = output;
}

async function pickStoreDir() {
  const dir = await ipcRenderer.invoke('select-directory');
  if (dir) {
    document.getElementById('storeDir').value = dir;
  }
}

function getConfig() {
  return {
    cliPath: document.getElementById('cliPath').value.trim(),
    storeDir: document.getElementById('storeDir').value.trim()
  };
}

async function startSend() {
  if (sendRunning) return;
  const filePath = document.getElementById('sendFile').value.trim();
  if (!filePath) {
    setStatus('sendStatus', 'Select a file to share.', 'error');
    return;
  }

  setStatus('sendTicketStatus', 'Preparing file…', 'info');
  updateProgress('sendTicketBar', 'sendTicketProgress', 0, progressState.sendTicketTotal);

  sendFilename = path.basename(filePath);
  currentTicket = '';
  currentShareToken = '';
  document.getElementById('sendLog').innerHTML = '';
  document.getElementById('ticketValue').textContent = '—';
  const shareEl = document.getElementById('shareTokenValue');
  if (shareEl) shareEl.textContent = '—';
  const copyShare = document.getElementById('copyShareBtn');
  const copyRaw = document.getElementById('copyRawBtn');
  if (copyShare) copyShare.disabled = true;
  if (copyRaw) copyRaw.disabled = true;
  resetSendUI();
  setStatus('sendTicketStatus', 'Creating ticket…', 'info');

  try {
    const cfg = getConfig();
    const sendMode = getSendMode();
    await ipcRenderer.invoke('start-send', { ...cfg, filePath, sendMode });
    sendRunning = true;
    setStatus('sendStatus', 'Sharing started. Waiting for receiver…', 'info');
    toggleSendButtons();
  } catch (err) {
    setStatus('sendStatus', err.message || 'Failed to start send.', 'error');
  }
}

async function stopSend() {
  await ipcRenderer.invoke('stop-send');
  sendRunning = false;
  toggleSendButtons();
  setStatus('sendStatus', 'Sharing stopped.', 'info');
}

function toggleSendButtons() {
  document.getElementById('startSendBtn').disabled = sendRunning;
  document.getElementById('stopSendBtn').disabled = !sendRunning;
}

async function startReceive() {
  if (receiveRunning) return;
  const inputValue = document.getElementById('receiveTicket').value.trim();
  const parsed = parseTicketInput(inputValue);
  const ticket = parsed.ticket;
  const fallbackTicket = parsed.fallbackTicket || '';
  if (parsed.filename) {
    receiveFilenameHint = parsed.filename;
  }
  if (typeof parsed.size === 'number') {
    receiveExpectedSize = parsed.size;
    progressState.receiveDownloadTotal = parsed.size;
  }
  const outputPath = document.getElementById('receiveOutput').value.trim();

  if (!ticket || !outputPath) {
    setStatus('receiveStatus', 'Ticket and output path are required.', 'error');
    return;
  }
  if (!ticketPrefix.test(ticket)) {
    setStatus('receiveStatus', 'Invalid ticket format. Copy the ticket from the sender.', 'error');
    return;
  }

  document.getElementById('receiveLog').innerHTML = '';
  resetReceiveUI();

  try {
    const cfg = getConfig();
    const expectedSize = typeof receiveExpectedSize === 'number' ? receiveExpectedSize : null;
    await ipcRenderer.invoke('start-receive', { ...cfg, ticket, fallbackTicket, outputPath, expectedSize });
    receiveRunning = true;
    setStatus('receiveStatus', 'Downloading…', 'info');
    toggleReceiveButtons();
  } catch (err) {
    setStatus('receiveStatus', err.message || 'Failed to start download.', 'error');
  }
}

async function stopReceive() {
  await ipcRenderer.invoke('stop-receive');
  receiveRunning = false;
  toggleReceiveButtons();
  setStatus('receiveStatus', 'Download stopped.', 'info');
}

function toggleReceiveButtons() {
  document.getElementById('startReceiveBtn').disabled = receiveRunning;
  document.getElementById('stopReceiveBtn').disabled = !receiveRunning;
}

function copyTicket() {
  const shareEl = document.getElementById('shareTokenValue');
  let token = shareEl ? shareEl.textContent.trim() : '';
  if (!tokenPrefix.test(token)) {
    token = currentShareToken || '';
  }

  if (!token) {
    const rawTicket = currentTicket || document.getElementById('ticketValue').textContent.trim();
    const extracted = extractBlobTicket(rawTicket) || extractBlobTicketFromLog();
    token = buildShareToken();
    currentShareToken = token;
    if (shareEl) shareEl.textContent = token || '—';
    const copyShare = document.getElementById('copyShareBtn');
    const copyRaw = document.getElementById('copyRawBtn');
    if (copyShare) copyShare.disabled = !token;
    if (copyRaw) copyRaw.disabled = !extracted;
  }

  if (!tokenPrefix.test(token)) {
    setStatus('sendStatus', 'Share token not ready yet.', 'error');
    return;
  }

  navigator.clipboard.writeText(token);
  appendLog('sendLog', `Copied share token: ${token}`, false);
}

function copyRawTicket() {
  if (!currentTicket) {
    const raw = document.getElementById('ticketValue').textContent.trim();
    const extracted = extractBlobTicket(raw) || extractBlobTicketFromLog();
    if (extracted) {
      currentTicket = extracted;
    }
  }
  if (!currentTicket) {
    setStatus('sendStatus', 'Raw ticket not ready yet.', 'error');
    return;
  }
  navigator.clipboard.writeText(currentTicket);
  appendLog('sendLog', `Copied raw ticket: ${currentTicket}`, false);
}

function handleEvent(channel, event) {
  if (!event || !event.type) return;

  if (channel === 'send') {
    switch (event.type) {
      case 'ticket_hashing_start':
        setStatus('sendTicketStatus', 'Creating ticket…', 'info');
        updateProgress('sendTicketBar', 'sendTicketProgress', 0, progressState.sendTicketTotal);
        break;
      case 'staging_start':
        setStatus('sendTicketStatus', 'Preparing file…', 'info');
        progressState.sendTicketTotal = typeof event.total === 'number' ? event.total : null;
        updateProgress('sendTicketBar', 'sendTicketProgress', 0, progressState.sendTicketTotal);
        break;
      case 'staging_progress':
        if (typeof event.total === 'number') {
          progressState.sendTicketTotal = event.total;
        }
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          event.bytes ?? 0,
          progressState.sendTicketTotal
        );
        break;
      case 'staging_complete':
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketTotal ?? 0,
          progressState.sendTicketTotal
        );
        setStatus('sendTicketStatus', 'File prepared. Hashing…', 'info');
        break;
      case 'staging_skipped':
        progressState.sendTicketTotal = event.total ?? progressState.sendTicketTotal;
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketTotal ?? 0,
          progressState.sendTicketTotal
        );
        setStatus('sendTicketStatus', 'Preparing file…', 'info');
        break;
      case 'staging_error':
        setStatus('sendTicketStatus', event.message || 'File preparation failed.', 'error');
        break;
      case 'ticket_hashing_size':
        progressState.sendTicketTotal = event.total ?? progressState.sendTicketTotal;
        if (typeof event.total === 'number') {
          sendFileSize = event.total;
        }
        updateProgress('sendTicketBar', 'sendTicketProgress', 0, progressState.sendTicketTotal);
        break;
      case 'ticket_hashing_progress':
        if (typeof event.total === 'number') {
          progressState.sendTicketTotal = event.total;
        }
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          event.bytes ?? 0,
          progressState.sendTicketTotal
        );
        break;
      case 'ticket_hashing_complete':
        setStatus('sendTicketStatus', 'Ticket ready.', 'success');
        break;
      case 'ticket_variants':
        currentTicketDirect = typeof event.direct === 'string' ? event.direct : '';
        currentTicketRelay = typeof event.relay === 'string' ? event.relay : '';
        currentTicketFull = typeof event.full === 'string' ? event.full : '';
        break;
      case 'ticket_created':
        if (event.ticket) {
          currentTicket = event.ticket;
          document.getElementById('ticketValue').textContent = currentTicket;
        }
        if (currentTicket) {
          const size = typeof event.total === 'number' ? event.total : (sendFileSize ?? progressState.sendTicketTotal);
          sendFileSize = size ?? sendFileSize;
          currentShareToken = buildShareToken();
          const shareEl = document.getElementById('shareTokenValue');
          if (shareEl) {
            shareEl.textContent = currentShareToken || '—';
          }
          const copyShare = document.getElementById('copyShareBtn');
          const copyRaw = document.getElementById('copyRawBtn');
          if (copyShare) copyShare.disabled = !currentShareToken;
          if (copyRaw) copyRaw.disabled = !currentTicket;
        }
        if (typeof event.total === 'number') {
          progressState.sendTicketTotal = event.total;
          sendFileSize = event.total;
          updateProgress('sendTicketBar', 'sendTicketProgress', event.total, event.total);
        }
        setStatus('sendTicketStatus', 'Ticket created.', 'success');
        setStatus('sendStatus', 'Waiting for receiver…', 'info');
        if (getSendMode() === 'direct' && !currentTicketDirect) {
          setStatus('sendStatus', 'Direct-only unavailable (no IPs). Switch to Direct + Relay.', 'error');
        }
        break;
      case 'receiver_connected':
        setStatus('sendReceiverStatus', 'Receiver connected.', 'success');
        setStatus('sendStatus', 'Uploading…', 'info');
        if (!sendConnectionStart) {
          sendConnectionStart = Date.now();
        }
        break;
      case 'receiver_disconnected':
        setStatus('sendReceiverStatus', 'Receiver disconnected.', 'error');
        break;
      case 'upload_started':
        progressState.sendUploadTotal = event.total ?? progressState.sendUploadTotal;
        speedSamples.sendUpload = [];
        sendSpeedBps = null;
        updateProgress('sendUploadBar', 'sendUploadProgress', 0, progressState.sendUploadTotal);
        setStatus('sendStatus', 'Uploading…', 'info');
        break;
      case 'upload_progress':
        if (typeof event.total === 'number') {
          progressState.sendUploadTotal = event.total;
        }
        if (typeof event.bytes === 'number') {
          const speed = updateRollingSpeed('sendUpload', event.bytes);
          if (speed !== null) sendSpeedBps = speed;
        }
        updateProgress(
          'sendUploadBar',
          'sendUploadProgress',
          event.bytes ?? 0,
          progressState.sendUploadTotal
        );
        break;
      case 'upload_complete':
        updateProgress(
          'sendUploadBar',
          'sendUploadProgress',
          progressState.sendUploadTotal ?? 0,
          progressState.sendUploadTotal ?? null
        );
        setStatus('sendReceiverStatus', 'Transfer complete.', 'success');
        setStatus('sendStatus', 'Upload complete.', 'success');
        sendCompleted = true;
        if (sendConnectionStart) {
          renderCompletionStats('send', progressState.sendUploadTotal ?? 0, sendConnectionStart, Date.now());
        }
        ipcRenderer.invoke('cleanup-transfers').catch(() => {});
        break;
      case 'upload_aborted':
        setStatus('sendStatus', 'Upload aborted.', 'error');
        break;
      case 'error':
        setStatus('sendStatus', event.message || 'Send error.', 'error');
        break;
      default:
        break;
    }
  } else {
    switch (event.type) {
      case 'connect_start':
        setStatus('receiveConnectStatus', 'Connecting…', 'info');
        break;
      case 'connect_success':
        setStatus('receiveConnectStatus', 'Connected.', 'success');
        if (!receiveConnectionStart) {
          receiveConnectionStart = Date.now();
        }
        break;
      case 'connect_failed':
        setStatus('receiveConnectStatus', 'Connection failed. Retrying…', 'error');
        break;
      case 'download_size':
        progressState.receiveDownloadTotal = event.total ?? progressState.receiveDownloadTotal;
        updateProgress('receiveDownloadBar', 'receiveDownloadProgress', 0, progressState.receiveDownloadTotal);
        break;
      case 'download_started':
        if (typeof event.total === 'number') {
          progressState.receiveDownloadTotal = event.total;
        }
        speedSamples.receiveDownload = [];
        receiveSpeedBps = null;
        updateProgress('receiveDownloadBar', 'receiveDownloadProgress', 0, progressState.receiveDownloadTotal);
        setStatus('receiveStatus', 'Downloading…', 'info');
        break;
      case 'download_retry':
        setStatus('receiveStatus', event.message || 'Retrying download…', 'info');
        break;
      case 'download_progress':
        if (typeof event.total === 'number') {
          progressState.receiveDownloadTotal = event.total;
        }
        if (typeof event.bytes === 'number') {
          const speed = updateRollingSpeed('receiveDownload', event.bytes);
          if (speed !== null) receiveSpeedBps = speed;
        }
        updateProgress(
          'receiveDownloadBar',
          'receiveDownloadProgress',
          event.bytes ?? 0,
          progressState.receiveDownloadTotal
        );
        break;
      case 'download_complete':
        updateProgress(
          'receiveDownloadBar',
          'receiveDownloadProgress',
          progressState.receiveDownloadTotal ?? 0,
          progressState.receiveDownloadTotal ?? null
        );
        setStatus('receiveStatus', 'Download complete. Exporting…', 'info');
        break;
      case 'export_started':
        progressState.receiveExportTotal = event.total ?? progressState.receiveExportTotal;
        updateProgress('receiveExportBar', 'receiveExportProgress', 0, progressState.receiveExportTotal);
        setStatus('receiveStatus', 'Exporting…', 'info');
        break;
      case 'export_size':
        progressState.receiveExportTotal = event.total ?? progressState.receiveExportTotal;
        updateProgress('receiveExportBar', 'receiveExportProgress', 0, progressState.receiveExportTotal);
        break;
      case 'export_progress':
        if (typeof event.total === 'number') {
          progressState.receiveExportTotal = event.total;
        }
        updateProgress(
          'receiveExportBar',
          'receiveExportProgress',
          event.bytes ?? 0,
          progressState.receiveExportTotal
        );
        break;
      case 'export_complete':
        updateProgress(
          'receiveExportBar',
          'receiveExportProgress',
          progressState.receiveExportTotal ?? 0,
          progressState.receiveExportTotal ?? null
        );
        setStatus('receiveStatus', 'Download complete.', 'success');
        receiveCompleted = true;
        if (receiveConnectionStart) {
          const totalBytes = progressState.receiveDownloadTotal ?? 0;
          renderCompletionStats('receive', totalBytes, receiveConnectionStart, Date.now());
        }
        ipcRenderer.invoke('cleanup-transfers').catch(() => {});
        ipcRenderer.invoke('cleanup-receive-store').catch(() => {});
        break;
      case 'error':
        setStatus('receiveStatus', event.message || 'Receive error.', 'error');
        setStatus('receiveConnectStatus', `Error: ${event.message || 'Receive error.'}`, 'error');
        break;
      default:
        break;
    }
  }
}

ipcRenderer.on('process-log', (event, { channel, message, isError }) => {
  const trimmed = message.toString().trim();
  if (!trimmed) return;
  if (channel === 'send') {
    appendLog('sendLog', trimmed, isError);
    const match = trimmed.match(ticketRegex);
    if (match && match[1]) {
      currentTicket = match[1];
      document.getElementById('ticketValue').textContent = currentTicket;
      if (!currentShareToken) {
        {
          const size = sendFileSize ?? progressState.sendTicketTotal;
          currentShareToken = encodeToken(currentTicket, sendFilename, size);
        }
        const shareEl = document.getElementById('shareTokenValue');
        if (shareEl) {
          shareEl.textContent = currentShareToken || '—';
        }
        const copyShare = document.getElementById('copyShareBtn');
        const copyRaw = document.getElementById('copyRawBtn');
        if (copyShare) copyShare.disabled = !currentShareToken;
        if (copyRaw) copyRaw.disabled = !currentTicket;
      }
    }
  } else {
    appendLog('receiveLog', trimmed, isError);
  }
});

ipcRenderer.on('process-event', (event, { channel, payload }) => {
  handleEvent(channel, payload);
  if (channel === 'send' && payload && payload.type === 'ticket_created' && payload.ticket) {
    currentTicket = payload.ticket;
    document.getElementById('ticketValue').textContent = currentTicket;
    {
      currentShareToken = buildShareToken();
    }
    const shareEl = document.getElementById('shareTokenValue');
    if (shareEl) {
      shareEl.textContent = currentShareToken || '—';
    }
    const copyShare = document.getElementById('copyShareBtn');
    const copyRaw = document.getElementById('copyRawBtn');
    if (copyShare) copyShare.disabled = !currentShareToken;
    if (copyRaw) copyRaw.disabled = !currentTicket;
  }
});

ipcRenderer.on('process-exit', (event, { channel, code }) => {
  if (channel === 'send') {
    sendRunning = false;
    toggleSendButtons();
    setStatus('sendStatus', `Send process exited (${code}).`, code === 0 ? 'success' : 'error');
  } else {
    receiveRunning = false;
    toggleReceiveButtons();
    if (code === 0) {
      setStatus('receiveStatus', 'Download complete.', 'success');
    } else {
      setStatus('receiveStatus', `Receive process exited (${code}).`, 'error');
    }
  }
});

document.getElementById('receiveTicket').addEventListener('input', (e) => {
  const { ticket, filename, size } = parseTicketInput(e.target.value);
  if (filename) {
    receiveFilenameHint = filename;
    const outputEl = document.getElementById('receiveOutput');
    if (!outputEl.value) {
      outputEl.placeholder = filename;
    }
  }
  if (typeof size === 'number') {
    receiveExpectedSize = size;
    progressState.receiveDownloadTotal = size;
    updateProgress('receiveDownloadBar', 'receiveDownloadProgress', 0, size);
  }
  if (ticket && ticket !== e.target.value) {
    // Preserve original input; just cache parsed ticket.
  }
});

document.querySelectorAll('input[name="sendMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (!currentTicket && !currentTicketDirect && !currentTicketRelay) return;
    const token = buildShareToken();
    currentShareToken = token;
    const shareEl = document.getElementById('shareTokenValue');
    if (shareEl) shareEl.textContent = token || '—';
    const copyShare = document.getElementById('copyShareBtn');
    if (copyShare) copyShare.disabled = !token;
    if (getSendMode() === 'direct' && !currentTicketDirect) {
      setStatus('sendStatus', 'Direct-only unavailable (no IPs). Switch to Direct + Relay.', 'error');
    }
  });
});

window.pickFile = pickFile;
window.pickOutput = pickOutput;
window.pickStoreDir = pickStoreDir;
window.startSend = startSend;
window.stopSend = stopSend;
window.startReceive = startReceive;
window.stopReceive = stopReceive;
window.copyTicket = copyTicket;
window.copyRawTicket = copyRawTicket;
