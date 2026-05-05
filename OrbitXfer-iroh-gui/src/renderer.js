const { ipcRenderer } = require('electron');
const path = require('path');

let sendRunning = false;
let receiveRunning = false;
let sendStopRequested = false;
let receiveStopRequested = false;
let transferMode = 'send';
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
let availableResumeState = { send: null, receive: null };
let resumePromptDismissed = false;

const speedSamples = {
  sendUpload: [],
  receiveDownload: []
};

const ticketRegex = /receive\s+(\S+)/;
const ticketPrefix = /^blob/i;
const tokenPrefix = /^ox[12]:/i;
const progressState = {
  sendTicketBytes: null,
  sendTicketTotal: null,
  sendUploadBytes: null,
  sendUploadTotal: null,
  receiveDownloadBytes: null,
  receiveDownloadTotal: null,
  receiveExportBytes: null,
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

function stripInvisibleCharacters(value) {
  return typeof value === 'string' ? value.replace(/[\u200B-\u200D\uFEFF]/g, '') : '';
}

function findDecodedShareToken(rawValue) {
  const normalized = stripInvisibleCharacters(rawValue || '');
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  if (tokenPrefix.test(trimmed)) {
    const decoded = decodeToken(trimmed);
    if (decoded) {
      return {
        token: trimmed,
        decoded,
        source: 'share-token',
        normalizedWhitespace: false
      };
    }
  }

  const compact = normalized.replace(/\s+/g, '');
  const prefixRegex = /ox[12]:/gi;
  let match;
  while ((match = prefixRegex.exec(compact)) !== null) {
    const remainder = compact.slice(match.index);
    const candidateMatch = remainder.match(/^ox[12]:[A-Za-z0-9_-]+/i);
    if (!candidateMatch) continue;
    const candidate = candidateMatch[0];
    for (let end = candidate.length; end > 4; end -= 1) {
      const token = candidate.slice(0, end);
      const decoded = decodeToken(token);
      if (decoded) {
        return {
          token,
          decoded,
          source: match.index === 0 && token === trimmed ? 'share-token' : 'embedded-share-token',
          normalizedWhitespace: compact !== trimmed
        };
      }
    }
  }

  return null;
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
  const raw = stripInvisibleCharacters(rawValue || '').trim();
  const result = {
    ticket: '',
    fallbackTicket: '',
    filename: '',
    size: null,
    source: 'empty',
    shareToken: '',
    issues: []
  };
  if (!raw) return result;

  const decodedShare = findDecodedShareToken(raw);
  if (decodedShare) {
    return {
      ...decodedShare.decoded,
      source: decodedShare.source,
      shareToken: decodedShare.token,
      issues: decodedShare.normalizedWhitespace ? ['normalized-whitespace'] : []
    };
  }
  if (/ox[12]:/i.test(raw)) {
    result.issues.push('share-token-decode-failed');
  }

  let ticket = raw;
  let fallbackTicket = '';
  let filename = '';
  let size = null;

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
      return {
        ticket,
        fallbackTicket,
        filename,
        size,
        source: 'orbitxfer-link',
        shareToken: '',
        issues: result.issues
      };
    } catch (_) {
      // Fall through to plain parsing.
    }
  }

  const receiveCommandMatch = raw.match(ticketRegex);
  if (receiveCommandMatch && receiveCommandMatch[1]) {
    ticket = receiveCommandMatch[1].trim();
    result.source = 'receive-command';
  }

  const pipeIdx = raw.indexOf('|');
  if (pipeIdx !== -1) {
    ticket = raw.slice(0, pipeIdx).trim();
    const meta = raw.slice(pipeIdx + 1).trim();
    if (meta.startsWith('name=')) {
      filename = decodeURIComponent(meta.slice(5));
    }
    return {
      ticket,
      fallbackTicket,
      filename,
      size,
      source: result.source === 'receive-command' ? result.source : 'piped-ticket',
      shareToken: '',
      issues: result.issues
    };
  }
  ticket = extractBlobTicket(ticket);
  return {
    ticket,
    fallbackTicket,
    filename,
    size,
    source: ticket ? (result.source === 'receive-command' ? result.source : 'blob-ticket') : 'unknown',
    shareToken: '',
    issues: result.issues
  };
}

function appendReceiveAppLog(message, isError = false) {
  appendLog('receiveLog', `[OrbitXfer] ${message}`, isError);
}

function summarizeValue(value, { lead = 18, tail = 10 } = {}) {
  if (!value) return '—';
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

function describeReceiveInputSource(source) {
  switch (source) {
    case 'share-token':
      return 'share token';
    case 'embedded-share-token':
      return 'share token recovered from surrounding text';
    case 'orbitxfer-link':
      return 'OrbitXfer share link';
    case 'receive-command':
      return 'receive command text';
    case 'piped-ticket':
      return 'ticket with metadata suffix';
    case 'blob-ticket':
      return 'raw blob ticket';
    case 'empty':
      return 'empty input';
    default:
      return 'unrecognized input';
  }
}

function logReceiveParseAttempt(inputValue, outputPath, parsed) {
  appendReceiveAppLog('Receive validation started.');
  appendReceiveAppLog(
    `Input source: ${describeReceiveInputSource(parsed.source)} (${inputValue.length} chars).`
  );
  if (parsed.shareToken) {
    appendReceiveAppLog(
      `Recovered share token ${summarizeValue(parsed.shareToken)} (${parsed.shareToken.length} chars).`
    );
  }
  if (parsed.ticket) {
    appendReceiveAppLog(`Using ticket ${summarizeValue(parsed.ticket)}.`);
  }
  if (parsed.filename) {
    appendReceiveAppLog(`Filename hint: ${parsed.filename}`);
  }
  if (typeof parsed.size === 'number') {
    appendReceiveAppLog(`Expected size hint: ${formatBytes(parsed.size)}.`);
  }
  if (parsed.issues.includes('normalized-whitespace')) {
    appendReceiveAppLog('Normalized wrapped or spaced token input before decoding.');
  }
  if (parsed.issues.includes('share-token-decode-failed')) {
    appendReceiveAppLog(
      'Detected a share-token marker, but the pasted token could not be decoded as-is.',
      true
    );
  }
  appendReceiveAppLog(`Destination: ${outputPath || '(not selected)'}`);
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

function normalizePathValue(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(value);
}

function normalizeTicketValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildShareTokenFromResumeState(state) {
  if (!state) return '';
  const size = typeof state.fileSize === 'number' ? state.fileSize : state.ticketTotal;
  if (state.sendMode === 'direct') {
    return state.directTicket ? encodeToken(state.directTicket, state.fileName, size) : '';
  }
  if (state.directTicket && state.relayTicket) {
    return encodeTokenV2(state.directTicket, state.relayTicket, state.fileName, size);
  }
  const baseTicket = state.ticket || state.fullTicket || state.directTicket || state.relayTicket;
  return baseTicket ? encodeToken(baseTicket, state.fileName, size) : '';
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('hidden', hidden);
  el.toggleAttribute('hidden', hidden);
}

function describeSendResume(state) {
  if (!state) return 'No interrupted send is available.';
  const name = state.fileName || path.basename(state.filePath || 'file');
  const uploaded = typeof state.uploadBytes === 'number' ? formatBytes(state.uploadBytes) : '0 B';
  const total = typeof state.uploadTotal === 'number'
    ? formatBytes(state.uploadTotal)
    : typeof state.fileSize === 'number'
      ? formatBytes(state.fileSize)
      : '—';
  return `${name} • ${uploaded} of ${total} ready to resume`;
}

function describeReceiveResume(state) {
  if (!state) return 'No interrupted receive is available.';
  const name = state.outputPath ? path.basename(state.outputPath) : 'download';
  const downloaded = typeof state.downloadBytes === 'number' ? formatBytes(state.downloadBytes) : '0 B';
  const total = typeof state.downloadTotal === 'number'
    ? formatBytes(state.downloadTotal)
    : typeof state.expectedSize === 'number'
      ? formatBytes(state.expectedSize)
      : '—';
  return `${name} • ${downloaded} of ${total} already downloaded`;
}

function renderResumeUI() {
  const sendState = availableResumeState.send;
  const receiveState = availableResumeState.receive;

  const sendBtn = document.getElementById('resumeSendBtn');
  const receiveBtn = document.getElementById('resumeReceiveBtn');
  const sendSummary = document.getElementById('sendResumeSummary');
  const receiveSummary = document.getElementById('receiveResumeSummary');

  if (sendBtn) sendBtn.disabled = !sendState || sendRunning;
  if (receiveBtn) receiveBtn.disabled = !receiveState || receiveRunning;
  if (sendSummary) sendSummary.textContent = describeSendResume(sendState);
  if (receiveSummary) receiveSummary.textContent = describeReceiveResume(receiveState);

  const prompt = document.getElementById('resumePrompt');
  const promptDetails = document.getElementById('resumePromptDetails');
  const promptSend = document.getElementById('resumePromptSendBtn');
  const promptReceive = document.getElementById('resumePromptReceiveBtn');
  const shouldShowPrompt =
    !resumePromptDismissed &&
    Boolean(sendState || receiveState) &&
    !sendRunning &&
    !receiveRunning;

  setHidden(prompt, !shouldShowPrompt);
  setHidden(promptSend, !sendState);
  setHidden(promptReceive, !receiveState);

  if (promptDetails) {
    const details = [];
    if (sendState) details.push(describeSendResume(sendState));
    if (receiveState) details.push(describeReceiveResume(receiveState));
    promptDetails.textContent = details.join('  |  ');
  }
}

function setAvailableResumeState(state, options = {}) {
  availableResumeState = {
    send: state?.send || null,
    receive: state?.receive || null
  };
  if (options.resetPrompt) {
    resumePromptDismissed = false;
  }
  renderResumeUI();
}

function dismissResumePrompt() {
  resumePromptDismissed = true;
  renderResumeUI();
}

function primeSendResumeState(state, options = {}) {
  if (!state) return;
  setTransferMode('send');
  const preserveFile = Boolean(options.preserveFile);
  if (!preserveFile) {
    document.getElementById('sendFile').value = state.filePath || '';
  }

  sendFilename = state.fileName || (state.filePath ? path.basename(state.filePath) : '');
  sendFileSize = typeof state.fileSize === 'number' ? state.fileSize : sendFileSize;
  currentTicket = state.ticket || state.fullTicket || state.directTicket || '';
  currentTicketDirect = state.directTicket || '';
  currentTicketRelay = state.relayTicket || '';
  currentTicketFull = state.fullTicket || '';
  currentShareToken = state.shareToken || buildShareTokenFromResumeState(state) || '';

  progressState.sendTicketTotal = typeof state.ticketTotal === 'number'
    ? state.ticketTotal
    : typeof state.fileSize === 'number'
      ? state.fileSize
      : progressState.sendTicketTotal;
  progressState.sendTicketBytes = typeof state.ticketBytes === 'number'
    ? state.ticketBytes
    : currentShareToken
      ? progressState.sendTicketTotal
      : progressState.sendTicketBytes;
  progressState.sendUploadTotal = typeof state.uploadTotal === 'number'
    ? state.uploadTotal
    : typeof state.fileSize === 'number'
      ? state.fileSize
      : progressState.sendUploadTotal;
  progressState.sendUploadBytes = typeof state.uploadBytes === 'number'
    ? state.uploadBytes
    : progressState.sendUploadBytes;

  document.getElementById('ticketValue').textContent = currentTicket || '—';
  const shareEl = document.getElementById('shareTokenValue');
  if (shareEl) shareEl.textContent = currentShareToken || '—';

  const copyShare = document.getElementById('copyShareBtn');
  const copyRaw = document.getElementById('copyRawBtn');
  if (copyShare) copyShare.disabled = !currentShareToken;
  if (copyRaw) copyRaw.disabled = !currentTicket;

  updateProgress(
    'sendTicketBar',
    'sendTicketProgress',
    progressState.sendTicketBytes,
    progressState.sendTicketTotal
  );
  updateProgress(
    'sendUploadBar',
    'sendUploadProgress',
    progressState.sendUploadBytes,
    progressState.sendUploadTotal
  );

  setStatus('sendTicketStatus', currentShareToken ? 'Ticket ready.' : 'Ready to resume.', currentShareToken ? 'success' : 'info');
  setStatus('sendReceiverStatus', 'Ready to resume interrupted transfer.', 'info');
  setStatus('sendStatus', 'Resume available. Start sharing to continue seeding.', 'info');
}

function primeReceiveResumeState(state, options = {}) {
  if (!state) return;
  setTransferMode('receive');
  const preserveTicketInput = Boolean(options.preserveTicketInput);
  const preserveOutput = Boolean(options.preserveOutput);

  if (!preserveTicketInput) {
    document.getElementById('receiveTicket').value = state.tokenInput || state.ticket || '';
  }
  if (!preserveOutput) {
    document.getElementById('receiveOutput').value = state.outputPath || '';
  }

  receiveFilenameHint = state.outputPath ? path.basename(state.outputPath) : receiveFilenameHint;
  receiveExpectedSize = typeof state.expectedSize === 'number'
    ? state.expectedSize
    : typeof state.downloadTotal === 'number'
      ? state.downloadTotal
      : receiveExpectedSize;

  progressState.receiveDownloadTotal = typeof state.downloadTotal === 'number'
    ? state.downloadTotal
    : typeof state.expectedSize === 'number'
      ? state.expectedSize
      : progressState.receiveDownloadTotal;
  progressState.receiveDownloadBytes = typeof state.downloadBytes === 'number'
    ? state.downloadBytes
    : progressState.receiveDownloadBytes;
  progressState.receiveExportTotal = typeof state.exportTotal === 'number'
    ? state.exportTotal
    : progressState.receiveDownloadTotal;
  progressState.receiveExportBytes = typeof state.exportBytes === 'number'
    ? state.exportBytes
    : progressState.receiveExportBytes;

  updateProgress(
    'receiveDownloadBar',
    'receiveDownloadProgress',
    progressState.receiveDownloadBytes,
    progressState.receiveDownloadTotal
  );
  updateProgress(
    'receiveExportBar',
    'receiveExportProgress',
    progressState.receiveExportBytes,
    progressState.receiveExportTotal
  );

  setStatus('receiveConnectStatus', 'Ready to resume.', 'info');
  setStatus('receiveStatus', 'Resume available. Start download to continue.', 'info');
}

function matchingReceiveResume(parsed, outputPath) {
  const saved = availableResumeState.receive;
  if (!saved) return null;
  if (!parsed?.ticket || !outputPath) return null;
  if (normalizeTicketValue(saved.ticket) !== normalizeTicketValue(parsed.ticket)) return null;
  if (normalizePathValue(saved.outputPath) !== normalizePathValue(outputPath)) return null;
  return saved;
}

async function resumeLastSend(options = {}) {
  const state = availableResumeState.send;
  if (!state) {
    setStatus('sendStatus', 'No interrupted send is available.', 'error');
    return;
  }
  resumePromptDismissed = true;
  primeSendResumeState(state);
  renderResumeUI();
  if (options.autoStart !== false) {
    await startSend({ resumeLast: true, resumeState: state });
  }
}

async function resumeLastReceive(options = {}) {
  const state = availableResumeState.receive;
  if (!state) {
    setStatus('receiveStatus', 'No interrupted receive is available.', 'error');
    return;
  }
  resumePromptDismissed = true;
  primeReceiveResumeState(state);
  renderResumeUI();
  if (options.autoStart !== false) {
    await startReceive({ resumeLast: true, resumeState: state });
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
  progressState.sendTicketBytes = null;
  progressState.sendTicketTotal = null;
  progressState.sendUploadBytes = null;
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
  progressState.receiveDownloadBytes = null;
  progressState.receiveDownloadTotal = null;
  progressState.receiveExportBytes = null;
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

function setTransferMode(mode) {
  if (mode !== 'send' && mode !== 'receive') return;

  transferMode = mode;

  const showingSend = mode === 'send';
  const sendPanel = document.getElementById('sendPanel');
  const receivePanel = document.getElementById('receivePanel');
  const sendBtn = document.getElementById('modeSendBtn');
  const receiveBtn = document.getElementById('modeReceiveBtn');

  if (sendPanel) {
    sendPanel.classList.toggle('hidden-panel', !showingSend);
    sendPanel.toggleAttribute('hidden', !showingSend);
  }
  if (receivePanel) {
    receivePanel.classList.toggle('hidden-panel', showingSend);
    receivePanel.toggleAttribute('hidden', showingSend);
  }

  if (sendBtn) {
    sendBtn.classList.toggle('mode-btn-active', showingSend);
    sendBtn.setAttribute('aria-pressed', showingSend ? 'true' : 'false');
  }
  if (receiveBtn) {
    receiveBtn.classList.toggle('mode-btn-active', !showingSend);
    receiveBtn.setAttribute('aria-pressed', showingSend ? 'false' : 'true');
  }

  document.title = showingSend ? 'OrbitXfer - Send' : 'OrbitXfer - Receive';
}

function getConfig() {
  return {
    cliPath: document.getElementById('cliPath').value.trim(),
    storeDir: document.getElementById('storeDir').value.trim()
  };
}

async function startSend(options = {}) {
  if (sendRunning) return;
  const resumeState = options.resumeState || null;
  const filePath = (resumeState?.filePath || document.getElementById('sendFile').value).trim();
  if (!filePath) {
    setStatus('sendStatus', 'Select a file to share.', 'error');
    return;
  }

  sendFilename = path.basename(filePath);
  document.getElementById('sendLog').innerHTML = '';
  resetSendUI();

  if (resumeState) {
    primeSendResumeState(resumeState, { preserveFile: true });
    setStatus('sendTicketStatus', 'Resuming ticket…', 'info');
    setStatus('sendStatus', 'Resuming previous share…', 'info');
  } else {
    currentTicket = '';
    currentShareToken = '';
    document.getElementById('ticketValue').textContent = '—';
    const shareEl = document.getElementById('shareTokenValue');
    if (shareEl) shareEl.textContent = '—';
    const copyShare = document.getElementById('copyShareBtn');
    const copyRaw = document.getElementById('copyRawBtn');
    if (copyShare) copyShare.disabled = true;
    if (copyRaw) copyRaw.disabled = true;
    setStatus('sendTicketStatus', 'Creating ticket…', 'info');
    updateProgress('sendTicketBar', 'sendTicketProgress', 0, progressState.sendTicketTotal);
  }

  try {
    const cfg = getConfig();
    const sendMode = getSendMode();
    sendStopRequested = false;
    await ipcRenderer.invoke('start-send', { ...cfg, filePath, sendMode, resumeLast: Boolean(resumeState) });
    sendRunning = true;
    setStatus(
      'sendStatus',
      resumeState ? 'Sharing resumed. Waiting for receiver…' : 'Sharing started. Waiting for receiver…',
      'info'
    );
    toggleSendButtons();
    renderResumeUI();
  } catch (err) {
    setStatus('sendStatus', err.message || 'Failed to start send.', 'error');
  }
}

async function stopSend() {
  sendStopRequested = true;
  try {
    await ipcRenderer.invoke('stop-send');
    setStatus('sendStatus', 'Stopping share…', 'info');
  } catch (err) {
    sendStopRequested = false;
    setStatus('sendStatus', err.message || 'Failed to stop share.', 'error');
  }
}

function toggleSendButtons() {
  document.getElementById('startSendBtn').disabled = sendRunning;
  document.getElementById('stopSendBtn').disabled = !sendRunning;
  renderResumeUI();
}

async function startReceive(options = {}) {
  if (receiveRunning) return;
  const resumeState = options.resumeState || null;
  const inputValue = (resumeState?.tokenInput || document.getElementById('receiveTicket').value).trim();
  const parsed = parseTicketInput(inputValue);
  const ticket = parsed.ticket;
  const fallbackTicket = parsed.fallbackTicket || '';
  const outputPath = (resumeState?.outputPath || document.getElementById('receiveOutput').value).trim();
  const matchedResume = resumeState || matchingReceiveResume(parsed, outputPath);
  if (parsed.filename) {
    receiveFilenameHint = parsed.filename;
  }
  if (typeof parsed.size === 'number') {
    receiveExpectedSize = parsed.size;
    progressState.receiveDownloadTotal = parsed.size;
  }

  document.getElementById('receiveLog').innerHTML = '';
  logReceiveParseAttempt(inputValue, outputPath, parsed);

  if (!ticket && !outputPath) {
    appendReceiveAppLog(
      'Validation failed: no decodable share token/blob ticket was found and no destination was selected.',
      true
    );
    setStatus('receiveStatus', 'Paste a share token and choose where to save the received file.', 'error');
    return;
  }
  if (!ticket) {
    appendReceiveAppLog(
      'Validation failed: no decodable share token or blob ticket was found in the pasted input.',
      true
    );
    setStatus('receiveStatus', 'Share token could not be decoded. Paste the token exactly as sent.', 'error');
    return;
  }
  if (!outputPath) {
    appendReceiveAppLog('Validation failed: destination path is empty.', true);
    setStatus('receiveStatus', 'Choose where to save the received file.', 'error');
    return;
  }
  if (!ticketPrefix.test(ticket)) {
    appendReceiveAppLog('Validation failed: the parsed ticket does not start with the expected blob prefix.', true);
    setStatus('receiveStatus', 'Invalid ticket format. Copy the ticket from the sender.', 'error');
    return;
  }
  resetReceiveUI();

  if (matchedResume) {
    primeReceiveResumeState(matchedResume, { preserveTicketInput: true, preserveOutput: true });
    appendReceiveAppLog('Matched an interrupted receive for this same token and destination.');
    setStatus('receiveStatus', 'Resuming previous download…', 'info');
  }

  try {
    const cfg = getConfig();
    const expectedSize =
      typeof receiveExpectedSize === 'number'
        ? receiveExpectedSize
        : typeof matchedResume?.expectedSize === 'number'
          ? matchedResume.expectedSize
          : null;
    receiveStopRequested = false;
    await ipcRenderer.invoke('start-receive', {
      ...cfg,
      ticket,
      fallbackTicket,
      outputPath,
      expectedSize,
      ticketInput: inputValue,
      resumeLast: Boolean(matchedResume)
    });
    appendReceiveAppLog('Receive request accepted. Waiting for the CLI to connect.');
    receiveRunning = true;
    setStatus('receiveStatus', 'Downloading into temporary transfer data…', 'info');
    toggleReceiveButtons();
    renderResumeUI();
  } catch (err) {
    appendReceiveAppLog(`Receive start failed before download began: ${err.message || String(err)}`, true);
    setStatus('receiveStatus', err.message || 'Failed to start download.', 'error');
  }
}

async function stopReceive() {
  receiveStopRequested = true;
  try {
    await ipcRenderer.invoke('stop-receive');
    setStatus('receiveStatus', 'Stopping download…', 'info');
  } catch (err) {
    receiveStopRequested = false;
    setStatus('receiveStatus', err.message || 'Failed to stop download.', 'error');
  }
}

function toggleReceiveButtons() {
  document.getElementById('startReceiveBtn').disabled = receiveRunning;
  document.getElementById('stopReceiveBtn').disabled = !receiveRunning;
  renderResumeUI();
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
        progressState.sendTicketBytes = 0;
        updateProgress('sendTicketBar', 'sendTicketProgress', progressState.sendTicketBytes, progressState.sendTicketTotal);
        break;
      case 'staging_start':
        setStatus('sendTicketStatus', 'Preparing file…', 'info');
        progressState.sendTicketBytes = 0;
        progressState.sendTicketTotal = typeof event.total === 'number' ? event.total : null;
        updateProgress('sendTicketBar', 'sendTicketProgress', progressState.sendTicketBytes, progressState.sendTicketTotal);
        break;
      case 'staging_progress':
        if (typeof event.total === 'number') {
          progressState.sendTicketTotal = event.total;
        }
        progressState.sendTicketBytes = typeof event.bytes === 'number' ? event.bytes : 0;
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketBytes,
          progressState.sendTicketTotal
        );
        break;
      case 'staging_complete':
        progressState.sendTicketBytes = progressState.sendTicketTotal ?? 0;
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketBytes,
          progressState.sendTicketTotal
        );
        setStatus('sendTicketStatus', 'File prepared. Hashing…', 'info');
        break;
      case 'staging_skipped':
        progressState.sendTicketTotal = event.total ?? progressState.sendTicketTotal;
        progressState.sendTicketBytes = progressState.sendTicketTotal ?? 0;
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketBytes,
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
        progressState.sendTicketBytes = 0;
        updateProgress('sendTicketBar', 'sendTicketProgress', progressState.sendTicketBytes, progressState.sendTicketTotal);
        break;
      case 'ticket_hashing_progress':
        if (typeof event.total === 'number') {
          progressState.sendTicketTotal = event.total;
        }
        progressState.sendTicketBytes = typeof event.bytes === 'number' ? event.bytes : 0;
        updateProgress(
          'sendTicketBar',
          'sendTicketProgress',
          progressState.sendTicketBytes,
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
          progressState.sendTicketBytes = event.total;
          updateProgress('sendTicketBar', 'sendTicketProgress', progressState.sendTicketBytes, event.total);
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
        if (typeof progressState.sendUploadBytes !== 'number') {
          progressState.sendUploadBytes = 0;
        }
        updateProgress('sendUploadBar', 'sendUploadProgress', progressState.sendUploadBytes, progressState.sendUploadTotal);
        setStatus('sendStatus', 'Uploading…', 'info');
        break;
      case 'upload_progress':
        if (typeof event.total === 'number') {
          progressState.sendUploadTotal = event.total;
        }
        if (typeof event.bytes === 'number') {
          progressState.sendUploadBytes = event.bytes;
          const speed = updateRollingSpeed('sendUpload', progressState.sendUploadBytes);
          if (speed !== null) sendSpeedBps = speed;
        }
        updateProgress(
          'sendUploadBar',
          'sendUploadProgress',
          progressState.sendUploadBytes ?? 0,
          progressState.sendUploadTotal
        );
        break;
      case 'upload_complete':
        progressState.sendUploadBytes = progressState.sendUploadTotal ?? 0;
        updateProgress(
          'sendUploadBar',
          'sendUploadProgress',
          progressState.sendUploadBytes,
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
        if (typeof progressState.receiveDownloadBytes !== 'number') {
          progressState.receiveDownloadBytes = 0;
        }
        updateProgress('receiveDownloadBar', 'receiveDownloadProgress', progressState.receiveDownloadBytes, progressState.receiveDownloadTotal);
        break;
      case 'download_resume_state':
        if (typeof event.total === 'number') {
          progressState.receiveDownloadTotal = event.total;
        }
        progressState.receiveDownloadBytes = typeof event.bytes === 'number' ? event.bytes : progressState.receiveDownloadBytes;
        updateProgress('receiveDownloadBar', 'receiveDownloadProgress', progressState.receiveDownloadBytes, progressState.receiveDownloadTotal);
        break;
      case 'download_started':
        if (typeof event.total === 'number') {
          progressState.receiveDownloadTotal = event.total;
        }
        speedSamples.receiveDownload = [];
        receiveSpeedBps = null;
        if (typeof progressState.receiveDownloadBytes !== 'number') {
          progressState.receiveDownloadBytes = 0;
        }
        updateProgress('receiveDownloadBar', 'receiveDownloadProgress', progressState.receiveDownloadBytes, progressState.receiveDownloadTotal);
        setStatus('receiveStatus', 'Downloading into temporary transfer data…', 'info');
        break;
      case 'download_retry':
        setStatus('receiveStatus', event.message || 'Retrying download…', 'info');
        break;
      case 'download_progress':
        if (typeof event.total === 'number') {
          progressState.receiveDownloadTotal = event.total;
        }
        if (typeof event.bytes === 'number') {
          progressState.receiveDownloadBytes = event.bytes;
          const speed = updateRollingSpeed('receiveDownload', progressState.receiveDownloadBytes);
          if (speed !== null) receiveSpeedBps = speed;
        }
        updateProgress(
          'receiveDownloadBar',
          'receiveDownloadProgress',
          progressState.receiveDownloadBytes ?? 0,
          progressState.receiveDownloadTotal
        );
        break;
      case 'download_complete':
        progressState.receiveDownloadBytes = progressState.receiveDownloadTotal ?? 0;
        updateProgress(
          'receiveDownloadBar',
          'receiveDownloadProgress',
          progressState.receiveDownloadBytes,
          progressState.receiveDownloadTotal ?? null
        );
        setStatus('receiveStatus', 'Finalizing into destination file…', 'info');
        break;
      case 'export_started':
        progressState.receiveExportTotal = event.total ?? progressState.receiveExportTotal;
        if (typeof progressState.receiveExportBytes !== 'number') {
          progressState.receiveExportBytes = 0;
        }
        updateProgress('receiveExportBar', 'receiveExportProgress', progressState.receiveExportBytes, progressState.receiveExportTotal);
        setStatus('receiveStatus', 'Finalizing into destination file…', 'info');
        break;
      case 'export_size':
        progressState.receiveExportTotal = event.total ?? progressState.receiveExportTotal;
        updateProgress('receiveExportBar', 'receiveExportProgress', progressState.receiveExportBytes, progressState.receiveExportTotal);
        break;
      case 'export_progress':
        if (typeof event.total === 'number') {
          progressState.receiveExportTotal = event.total;
        }
        progressState.receiveExportBytes = typeof event.bytes === 'number' ? event.bytes : progressState.receiveExportBytes;
        updateProgress(
          'receiveExportBar',
          'receiveExportProgress',
          progressState.receiveExportBytes ?? 0,
          progressState.receiveExportTotal
        );
        break;
      case 'export_complete':
        progressState.receiveExportBytes = progressState.receiveExportTotal ?? 0;
        updateProgress(
          'receiveExportBar',
          'receiveExportProgress',
          progressState.receiveExportBytes,
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
      if (typeof progressState.sendTicketTotal === 'number') {
        progressState.sendTicketBytes = progressState.sendTicketTotal;
      }
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

ipcRenderer.on('resume-state', (event, state) => {
  setAvailableResumeState(state);
});

ipcRenderer.on('menu-action', async (event, payload) => {
  const action = payload?.action;
  if (action === 'resume-last-send') {
    await resumeLastSend();
  } else if (action === 'resume-last-receive') {
    await resumeLastReceive();
  }
});

ipcRenderer.on('process-exit', (event, { channel, code }) => {
  if (channel === 'send') {
    sendRunning = false;
    toggleSendButtons();
    if (sendStopRequested) {
      sendStopRequested = false;
      setStatus('sendStatus', 'Sharing stopped.', 'info');
      return;
    }
    setStatus('sendStatus', `Send process exited (${code}).`, code === 0 ? 'success' : 'error');
  } else {
    receiveRunning = false;
    toggleReceiveButtons();
    if (receiveStopRequested) {
      receiveStopRequested = false;
      setStatus('receiveStatus', 'Download stopped.', 'info');
      return;
    }
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
    if (typeof progressState.receiveDownloadBytes !== 'number') {
      progressState.receiveDownloadBytes = 0;
    }
    updateProgress('receiveDownloadBar', 'receiveDownloadProgress', progressState.receiveDownloadBytes, size);
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
window.setTransferMode = setTransferMode;
window.startSend = startSend;
window.stopSend = stopSend;
window.startReceive = startReceive;
window.stopReceive = stopReceive;
window.copyTicket = copyTicket;
window.copyRawTicket = copyRawTicket;
window.resumeLastSend = resumeLastSend;
window.resumeLastReceive = resumeLastReceive;
window.dismissResumePrompt = dismissResumePrompt;

setTransferMode(transferMode);
renderResumeUI();
ipcRenderer.invoke('get-resume-state')
  .then((state) => setAvailableResumeState(state, { resetPrompt: true }))
  .catch(() => {
    renderResumeUI();
  });
