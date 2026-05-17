const state = {
  token: '',
  port: 3001,
  lanIp: '',
  addresses: [],
  devices: [],
  smsLogs: [],
  applications: [],
  queue: [],
  health: null,
  userCode: '',
  currentPage: 'overview',
  authMode: 'signin',
  otpEmail: '',
  otpRequired: false,
  resetToken: ''
};

const pageMeta = {
  overview: ['Overview', 'Send SMS, monitor connected phones, and keep the bridge healthy.'],
  messages: ['Messages', 'Search, filter, delete, and export SMS activity.'],
  devices: ['Devices', 'Inspect connected Android phones, SIM metadata, and the live command queue.'],
  applications: ['Applications', 'Manage API keys and integration examples for other services.'],
  system: ['System', 'Review pairing details, server health, and local security guidance.']
};

const els = {
  status: document.querySelector('#status'),
  pageTitle: document.querySelector('#pageTitle'),
  pageDescription: document.querySelector('#pageDescription'),
  welcomeUser: document.querySelector('#welcomeUser'),
  navButtons: document.querySelectorAll('.navButton'),
  pages: document.querySelectorAll('.page'),
  devices: document.querySelector('#devices'),
  logs: document.querySelector('#logs'),
  recentLogs: document.querySelector('#recentLogs'),
  queue: document.querySelector('#queue'),
  queuePreview: document.querySelector('#queuePreview'),
  health: document.querySelector('#health'),
  statOnline: document.querySelector('#statOnline'),
  statAvailable: document.querySelector('#statAvailable'),
  statQueue: document.querySelector('#statQueue'),
  statLogs: document.querySelector('#statLogs'),
  filter: document.querySelector('#filter'),
  directionFilter: document.querySelector('#directionFilter'),
  statusFilter: document.querySelector('#statusFilter'),
  applicationFilter: document.querySelector('#applicationFilter'),
  deviceFilter: document.querySelector('#deviceFilter'),
  exportJson: document.querySelector('#exportJson'),
  exportCsv: document.querySelector('#exportCsv'),
  address: document.querySelector('#address'),
  body: document.querySelector('#body'),
  flash: document.querySelector('#flash'),
  send: document.querySelector('#send'),
  sendResult: document.querySelector('#sendResult'),
  clearLogs: document.querySelector('#clearLogs'),
  pairingHostText: document.querySelector('#pairingHostText'),
  pairingPortText: document.querySelector('#pairingPortText'),
  pairingPreview: document.querySelector('#pairingPreview'),
  systemHostText: document.querySelector('#systemHostText'),
  systemPortText: document.querySelector('#systemPortText'),
  systemUserCodeText: document.querySelector('#systemUserCodeText'),
  addDevice: document.querySelector('#addDevice'),
  devicePairingModal: document.querySelector('#devicePairingModal'),
  devicePairingQr: document.querySelector('#devicePairingQr'),
  devicePairingResult: document.querySelector('#devicePairingResult'),
  cancelDevicePairing: document.querySelector('#cancelDevicePairing'),
  closeDevicePairing: document.querySelector('#closeDevicePairing'),
  addApplication: document.querySelector('#addApplication'),
  applicationsList: document.querySelector('#applicationsList'),
  applicationModal: document.querySelector('#applicationModal'),
  applicationName: document.querySelector('#applicationName'),
  applicationResult: document.querySelector('#applicationResult'),
  cancelApplication: document.querySelector('#cancelApplication'),
  createApplication: document.querySelector('#createApplication'),
  sendSample: document.querySelector('#sendSample'),
  receiveSample: document.querySelector('#receiveSample')
};

Object.assign(els, {
  authModal: document.querySelector('#authModal'),
  authTitle: document.querySelector('#authTitle'),
  authSubtitle: document.querySelector('#authSubtitle'),
  authSetupWarning: document.querySelector('#authSetupWarning'),
  showSignin: document.querySelector('#showSignin'),
  showSignup: document.querySelector('#showSignup'),
  authName: document.querySelector('#authName'),
  authEmail: document.querySelector('#authEmail'),
  authPassword: document.querySelector('#authPassword'),
  authPasswordWrap: document.querySelector('#authPasswordWrap'),
  authFields: document.querySelector('#authFields'),
  otpFields: document.querySelector('#otpFields'),
  otpCode: document.querySelector('#otpCode'),
  resendOtp: document.querySelector('#resendOtp'),
  resetPasswordFields: document.querySelector('#resetPasswordFields'),
  newPassword: document.querySelector('#newPassword'),
  confirmPassword: document.querySelector('#confirmPassword'),
  authMessage: document.querySelector('#authMessage'),
  authSubmit: document.querySelector('#authSubmit'),
  logoutButton: document.querySelector('#logoutButton'),
  resendOtpTimer: document.querySelector('#resendOtpTimer'),
  forgotPassword: document.querySelector('#forgotPassword')
});

let resendOtpInterval = null;
let healthQueueInterval = null;
const eyeIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.2 12s3.5-6 9.8-6 9.8 6 9.8 6-3.5 6-9.8 6-9.8-6-9.8-6z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>`;
const eyeOffIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3l18 18"></path>
    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
    <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.3 0 9.8 7 9.8 7a17.4 17.4 0 0 1-2.9 3.8"></path>
    <path d="M6.6 6.6C3.7 8.5 2.2 12 2.2 12s3.5 7 9.8 7c1.6 0 3-.4 4.2-1"></path>
  </svg>`;

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderDevices() {
  if (!state.devices.length) {
    els.devices.className = 'list empty';
    els.devices.textContent = 'No devices connected';
    return;
  }
  els.devices.className = 'list';
  els.devices.innerHTML = state.devices.map((device) => `
    <article class="item">
      <div class="deviceHead">
        <strong>${escapeHtml(device.deviceName || device.name || device.model || 'Android device')}</strong>
        <span class="statusBadge ${device.available ? 'available' : device.busy ? 'busy' : device.online ? 'online' : 'offline'}">
          ${device.available ? 'Available' : device.busy ? 'Busy' : device.online ? 'Online' : 'Offline'}
        </span>
      </div>
      <p>${escapeHtml(device.manufacturer || '')} ${escapeHtml(device.model || '')}</p>
      <small>${escapeHtml(device.id || '')}</small>
      <small>${device.selectedSimLabel ? `Selected SIM: ${escapeHtml(device.selectedSimLabel)}` : 'Selected SIM: system default'}</small>
      ${Array.isArray(device.sims) && device.sims.length ? `<small>SIMs: ${device.sims.map((sim) => escapeHtml(sim.label || `SIM ${sim.slotIndex + 1}`)).join(', ')}</small>` : ''}
      <small>Last seen ${formatTime(device.lastSeenAt)}</small>
      <div class="deviceActions">
        <button class="danger compact deleteDevice" data-id="${escapeHtml(device.id || '')}">Remove device</button>
      </div>
    </article>
  `).join('');
}

function queueMarkup(commands) {
  return commands.map((command) => `
    <article class="item">
      <div class="deviceHead">
        <strong>${escapeHtml(command.payload?.address || command.address || 'Unknown recipient')}</strong>
        <span class="statusBadge ${command.status === 'queued' ? 'busy' : 'online'}">${escapeHtml(command.status)}</span>
      </div>
      <p>${escapeHtml(command.applicationName || 'dashboard')}</p>
      <small>${command.assignedDeviceId ? `Assigned to ${escapeHtml(command.assignedDeviceId)}` : 'Waiting for available phone'}</small>
      <small>Created ${formatTime(command.createdAt)}</small>
    </article>
  `).join('');
}

function renderQueueTarget(target, commands, compact = false) {
  if (!commands.length) {
    target.className = 'list empty';
    target.textContent = state.devices.some((device) => device.available) ? 'No queued commands' : 'No queued commands. If you send now, messages will wait for an available phone.';
    return;
  }
  target.className = 'list';
  target.innerHTML = queueMarkup(compact ? commands.slice(0, 4) : commands);
}

function renderQueue() {
  renderQueueTarget(els.queue, state.queue);
  renderQueueTarget(els.queuePreview, state.queue, true);
}

function renderHealth() {
  const health = state.health;
  if (!health) {
    els.health.className = 'metaGrid empty';
    els.health.textContent = 'Loading health...';
    return;
  }
  els.health.className = 'metaGrid';
  els.health.innerHTML = `
    <span>Server</span><strong>${escapeHtml(health.lanIp)}:${escapeHtml(health.port)}</strong>
    <span>Devices</span><strong>${health.devices?.online || 0} online / ${health.devices?.available || 0} available / ${health.devices?.busy || 0} busy</strong>
    <span>Queue</span><strong>${health.queueSize || 0}</strong>
    <span>SMS logs</span><strong>${health.smsLogCount || 0}</strong>
    <span>Applications</span><strong>${health.applicationCount || 0}</strong>
    <span>Uptime</span><strong>${Math.floor((health.uptimeSeconds || 0) / 60)} min</strong>
  `;
}

function renderStats() {
  const online = state.devices.filter((device) => device.online).length;
  const available = state.devices.filter((device) => device.available).length;
  els.statOnline.textContent = online;
  els.statAvailable.textContent = available;
  els.statQueue.textContent = state.queue.length;
  els.statLogs.textContent = state.smsLogs.length;
}

function apiBaseUrl() {
  return `${location.protocol}//${location.host}`;
}

function renderSamples(apiKey = 'YOUR_API_KEY') {
  const baseUrl = apiBaseUrl();
  const userCode = state.userCode || 'YOUR_USER_CODE';
  els.sendSample.textContent = `import { ZiskConnectClient } from './zisk-connect-client.js';

const zisk = new ZiskConnectClient({
  baseUrl: '${baseUrl}',
  userCode: '${userCode}',
  apiKey: '${apiKey}'
});

const result = await zisk.sendSms({
  address: '9876543210',
  body: 'Hello from my app'
});

console.log(result);`;

  els.receiveSample.textContent = `<script src="${baseUrl}/zisk-connect-client.js"></script>
<script>
const zisk = new ZiskConnectClient({
  baseUrl: '${baseUrl}',
  userCode: '${userCode}',
  apiKey: '${apiKey}'
});

zisk.getIncomingSms(25).then(({ logs }) => {
  console.log(logs);
});
</script>`;
}

function renderApplications(selectedApiKey = '') {
  renderSamples(selectedApiKey || state.applications[0]?.apiKey || 'YOUR_API_KEY');

  if (!state.applications.length) {
    els.applicationsList.className = 'applicationsList empty';
    els.applicationsList.textContent = 'No applications added yet';
    return;
  }

  els.applicationsList.className = 'applicationsList';
  els.applicationsList.innerHTML = state.applications.map((application) => `
    <article class="applicationCard">
      <div>
        <strong>${escapeHtml(application.name)}</strong>
        <small>Created ${formatTime(application.createdAt)}</small>
      </div>
      <code>${escapeHtml(application.apiKey)}</code>
      <div class="applicationActions">
        <button class="secondary regenerateApplication" data-id="${escapeHtml(application.id)}">Regenerate key</button>
        <button class="danger deleteApplication" data-id="${escapeHtml(application.id)}">Delete</button>
      </div>
    </article>
  `).join('');
}

function renderConnectionStatus() {
  const online = state.devices.filter((device) => device.online).length;
  const available = state.devices.filter((device) => device.available).length;
  const busy = state.devices.filter((device) => device.busy).length;
  if (!online) {
    els.status.textContent = 'Dashboard connected. Waiting for Android device.';
    return;
  }
  els.status.textContent = `${online} Android device${online === 1 ? '' : 's'} connected - ${available} available, ${busy} busy.`;
}

function renderLogs() {
  const query = els.filter.value.trim().toLowerCase();
  const direction = els.directionFilter.value;
  const status = els.statusFilter.value;
  const applicationId = els.applicationFilter.value;
  const deviceId = els.deviceFilter.value;
  const logs = state.smsLogs
    .filter((log) => !query || `${log.address} ${log.body} ${log.applicationName} ${log.status}`.toLowerCase().includes(query))
    .filter((log) => !direction || log.direction === direction)
    .filter((log) => !status || log.status === status)
    .filter((log) => !applicationId || log.applicationId === applicationId)
    .filter((log) => !deviceId || log.assignedDeviceId === deviceId || log.sourceDevice === deviceId);

  renderLogList(els.logs, logs, state.smsLogs.length ? 'No logs match your search' : 'No SMS logs yet');
}

function logMarkup(logs) {
  return logs.map((log) => `
    <article class="log" data-id="${log.id}">
      <div class="logTop">
        <span>${escapeHtml(log.direction || 'unknown')} - ${escapeHtml(log.address || 'unknown')}</span>
        <span>${formatTime(log.timestamp)}</span>
      </div>
      <p>${escapeHtml(log.body || '')}</p>
      <div class="logFoot">
        <small>${escapeHtml(log.status || '')}${log.applicationName ? ` - ${escapeHtml(log.applicationName)}` : ''}${log.assignedDeviceId ? ` - ${escapeHtml(log.assignedDeviceId)}` : ''}${log.resultMessage ? ` - ${escapeHtml(log.resultMessage)}` : ''}</small>
        <button class="deleteLog" data-id="${escapeHtml(log.id)}">Delete</button>
      </div>
    </article>
  `).join('');
}

function renderLogList(target, logs, emptyText) {
  if (!logs.length) {
    target.className = 'logList empty';
    target.textContent = emptyText;
    return;
  }
  target.className = 'logList';
  target.innerHTML = logMarkup(logs);
}

function renderRecentLogs() {
  renderLogList(els.recentLogs, state.smsLogs.slice(0, 5), 'No SMS logs yet');
}

function renderFilters() {
  const statuses = [...new Set(state.smsLogs.map((log) => log.status).filter(Boolean))].sort();
  const statusValue = els.statusFilter.value;
  els.statusFilter.innerHTML = '<option value="">All statuses</option>' + statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('');
  els.statusFilter.value = statuses.includes(statusValue) ? statusValue : '';

  const appValue = els.applicationFilter.value;
  els.applicationFilter.innerHTML = '<option value="">All applications</option>' + state.applications.map((app) => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.name)}</option>`).join('');
  els.applicationFilter.value = state.applications.some((app) => app.id === appValue) ? appValue : '';

  const deviceValue = els.deviceFilter.value;
  els.deviceFilter.innerHTML = '<option value="">All devices</option>' + state.devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.model || device.id)}</option>`).join('');
  els.deviceFilter.value = state.devices.some((device) => device.id === deviceValue) ? deviceValue : '';
}

function renderAll() {
  const host = pairingHost();
  const scheme = pairingScheme();
  const port = pairingPort(scheme);
  els.pairingHostText.textContent = host;
  els.pairingPortText.textContent = port;
  els.systemHostText.textContent = host;
  els.systemPortText.textContent = port;
  els.systemUserCodeText.textContent = state.userCode || 'detecting';
  els.pairingPreview.textContent = `Add Device QR uses ${scheme}://${host}:${port}`;
  renderDevices();
  renderQueue();
  renderHealth();
  renderStats();
  renderFilters();
  renderConnectionStatus();
  renderLogs();
  renderRecentLogs();
  renderApplications();
}

function renderAddressOptions() {
  state.lanIp = state.lanIp || state.addresses?.[0]?.address || '127.0.0.1';
}

function pairingHost() {
  const browserHost = location.hostname || '';
  const localhostNames = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  if (browserHost && !localhostNames.has(browserHost)) return browserHost;
  return state.lanIp || browserHost || '127.0.0.1';
}

function pairingScheme() {
  return location.protocol === 'https:' ? 'https' : 'http';
}

function pairingPort(scheme = pairingScheme()) {
  if (location.port) return Number(location.port);
  if (scheme === 'https') return 443;
  return Number(state.port || 3001);
}

async function loadState() {
  const response = await fetch('/api/state');
  const data = await response.json();
  state.token = data.token;
  state.port = data.port || Number(location.port || 3001);
  state.lanIp = data.lanIp || '';
  state.addresses = data.addresses || [];
  state.devices = data.devices || [];
  state.smsLogs = data.smsLogs || [];
  state.queue = data.queue || [];
  state.health = data.health || null;
  state.userCode = data.userCode || state.userCode || '';
  renderAddressOptions();
  renderAll();
}

async function authFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { 'content-type': 'application/json' } : {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Authentication failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setAuthMode(mode) {
  state.authMode = mode;
  state.otpRequired = false;
  state.resetToken = '';
  stopOtpResendTimer();
  els.authName.classList.toggle('hidden', mode !== 'signup');
  els.authPasswordWrap.classList.toggle('hidden', mode === 'forgot');
  els.otpFields.classList.add('hidden');
  els.resetPasswordFields.classList.add('hidden');
  els.authFields.classList.remove('hidden');
  els.showSignin.classList.toggle('active', mode === 'signin');
  els.showSignup.classList.toggle('active', mode === 'signup');
  els.forgotPassword.classList.toggle('hidden', mode !== 'signin');
  els.authTitle.textContent = mode === 'signup'
    ? 'Create Zisk Connect account'
    : mode === 'forgot'
      ? 'Reset password'
      : 'Sign in to Zisk Connect';
  els.authSubtitle.textContent = mode === 'signup'
    ? 'We will send a Gmail OTP to verify your email.'
    : mode === 'forgot'
      ? 'Enter your email and we will send a reset OTP.'
      : 'Use your dashboard account to continue.';
  els.authSubmit.textContent = mode === 'signup'
    ? 'Create account'
    : mode === 'forgot'
      ? 'Send reset OTP'
      : 'Sign in';
  els.authMessage.textContent = '';
}

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.passwordToggle');
  if (!toggle) return;
  const input = document.querySelector(`#${toggle.dataset.target}`);
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  toggle.innerHTML = isHidden ? eyeOffIcon : eyeIcon;
  toggle.setAttribute('aria-label', `${isHidden ? 'Hide' : 'Show'} password`);
});

document.querySelectorAll('.passwordToggle').forEach((toggle) => {
  toggle.innerHTML = eyeIcon;
});

function stopOtpResendTimer() {
  if (resendOtpInterval) clearInterval(resendOtpInterval);
  resendOtpInterval = null;
  els.resendOtp.disabled = false;
  els.resendOtp.textContent = 'Resend OTP';
  els.resendOtpTimer.textContent = '';
}

function startOtpResendTimer(seconds = 60) {
  const deadline = Date.now() + Math.max(Number(seconds) || 60, 1) * 1000;
  if (resendOtpInterval) clearInterval(resendOtpInterval);
  function tick() {
    const remaining = Math.max(Math.ceil((deadline - Date.now()) / 1000), 0);
    if (!remaining) {
      stopOtpResendTimer();
      return;
    }
    els.resendOtp.disabled = true;
    els.resendOtp.textContent = `Resend in ${remaining}s`;
    els.resendOtpTimer.textContent = `You can request a new OTP after ${remaining}s.`;
  }
  tick();
  resendOtpInterval = setInterval(tick, 1000);
}

function showOtp(email, purpose = 'signup') {
  state.otpEmail = email;
  state.otpRequired = true;
  els.authFields.classList.add('hidden');
  els.otpFields.classList.remove('hidden');
  els.resetPasswordFields.classList.add('hidden');
  els.authTitle.textContent = purpose === 'password_reset' ? 'Verify reset OTP' : 'Verify OTP';
  els.authSubtitle.textContent = purpose === 'password_reset'
    ? `Enter the code sent to ${email}.`
    : `Enter the code sent to ${email}.`;
  els.authSubmit.textContent = purpose === 'password_reset' ? 'Verify OTP' : 'Verify and continue';
  els.authMessage.textContent = '';
  startOtpResendTimer(60);
  els.otpCode.focus();
}

function showPasswordResetFields() {
  state.otpRequired = false;
  stopOtpResendTimer();
  els.authFields.classList.add('hidden');
  els.otpFields.classList.add('hidden');
  els.resetPasswordFields.classList.remove('hidden');
  els.authTitle.textContent = 'Create new password';
  els.authSubtitle.textContent = 'Enter and confirm your new Zisk Connect password.';
  els.authSubmit.textContent = 'Change password';
  els.authMessage.textContent = '';
  els.newPassword.focus();
}

function showAuthModal(message = '') {
  els.authModal.classList.remove('hidden');
  els.authMessage.textContent = message;
}

function hideAuthModal() {
  els.authModal.classList.add('hidden');
  els.logoutButton.classList.remove('hidden');
}

function stopHealthQueuePolling() {
  if (!healthQueueInterval) return;
  clearInterval(healthQueueInterval);
  healthQueueInterval = null;
}

function handleAuthExpired() {
  stopHealthQueuePolling();
  els.logoutButton.classList.add('hidden');
  els.welcomeUser.classList.add('hidden');
  showAuthModal('Sign in required. Please sign in again.');
}

function setCurrentUser(user) {
  const displayName = user?.name || user?.email || 'User';
  state.userCode = user?.userCode || state.userCode || '';
  els.welcomeUser.classList.remove('hidden');
  els.welcomeUser.innerHTML = `<span>Welcome</span><strong>${escapeHtml(displayName)}</strong>${state.userCode ? `<small>User code: ${escapeHtml(state.userCode)}</small>` : ''}`;
}

async function ensureAuthenticated() {
  const config = await authFetch('/api/auth/config');
  els.authSetupWarning.classList.toggle('hidden', config.enabled);
  const session = await authFetch('/api/auth/me');
  if (session.authenticated) {
    setCurrentUser(session.user);
    hideAuthModal();
    return true;
  }
  showAuthModal(config.enabled ? '' : 'Server auth setup is incomplete.');
  return false;
}

async function loadApplications() {
  const data = await authedFetch('/api/applications');
  state.applications = data.applications || [];
  renderApplications();
}

async function loadHealthAndQueue() {
  try {
    const [health, queue] = await Promise.all([
      authedFetch('/api/health'),
      authedFetch('/api/queue')
    ]);
    state.health = health;
    state.queue = queue.queue || [];
    renderAll();
  } catch (error) {
    if (error.status === 401) handleAuthExpired();
    throw error;
  }
}

function connectSocket() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?role=dashboard`);
  ws.addEventListener('open', () => {
    renderConnectionStatus();
  });
  ws.addEventListener('close', () => {
    els.status.textContent = 'Dashboard socket disconnected. Reconnecting...';
    setTimeout(connectSocket, 1500);
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.event === 'state') {
      state.token = message.data.token;
      state.port = message.data.port || state.port;
      state.lanIp = message.data.lanIp || state.lanIp;
      state.addresses = message.data.addresses || state.addresses;
      state.devices = message.data.devices || [];
      state.smsLogs = message.data.smsLogs || [];
      state.queue = message.data.queue || [];
      state.health = message.data.health || null;
      state.userCode = message.data.userCode || state.userCode || '';
      renderAddressOptions();
    }
    if (message.event === 'token:changed') state.token = message.data.token;
    if (message.event === 'device:registered') {
      state.devices = [message.data, ...state.devices.filter((device) => device.id !== message.data.id)];
    }
    if (message.event === 'devices:state') state.devices = message.data || [];
    if (message.event === 'sms:logs') state.smsLogs = message.data || [];
    if (message.event === 'queue:state') state.queue = message.data || [];
    if (message.event === 'sms:event') state.smsLogs = [message.data, ...state.smsLogs.filter((log) => log.id !== message.data.id)];
    renderAll();
  });
}

els.filter.addEventListener('input', renderLogs);
els.directionFilter.addEventListener('change', renderLogs);
els.statusFilter.addEventListener('change', renderLogs);
els.applicationFilter.addEventListener('change', renderLogs);
els.deviceFilter.addEventListener('change', renderLogs);

async function authedFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.headers || {}),
      'x-pairing-token': state.token
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function showPage(page) {
  state.currentPage = page;
  const meta = pageMeta[page] || pageMeta.overview;
  els.pageTitle.textContent = meta[0];
  els.pageDescription.textContent = meta[1];
  els.pages.forEach((section) => section.classList.toggle('active', section.id === `${page}Page`));
  els.navButtons.forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  if (page === 'applications') {
    loadApplications().catch((error) => {
      els.applicationResult.textContent = error.message;
    });
  }
}

function openApplicationModal() {
  els.applicationName.value = '';
  els.applicationResult.textContent = '';
  els.applicationModal.classList.remove('hidden');
  els.applicationName.focus();
}

function closeApplicationModal() {
  els.applicationModal.classList.add('hidden');
}

function closeDevicePairingModal() {
  els.devicePairingModal.classList.add('hidden');
}

async function openDevicePairingModal() {
  els.devicePairingResult.textContent = 'Generating device QR...';
  els.devicePairingQr.removeAttribute('src');
  els.devicePairingModal.classList.remove('hidden');
  const response = await fetch('/api/devices/pairings', { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Device pairing failed');
  const host = pairingHost();
  const scheme = pairingScheme();
  const port = pairingPort(scheme);
  els.devicePairingQr.src = `/api/devices/pairings/${encodeURIComponent(data.pairing.id)}/qr.svg?scheme=${encodeURIComponent(scheme)}&host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&v=${Date.now()}`;
  els.devicePairingResult.textContent = 'Waiting for Android app scan...';
}

document.addEventListener('click', async (event) => {
  const jump = event.target.closest('[data-page-jump]');
  if (jump) showPage(jump.dataset.pageJump);

  const deviceButton = event.target.closest('.deleteDevice');
  if (deviceButton) {
    const device = state.devices.find((item) => item.id === deviceButton.dataset.id);
    const name = device?.deviceName || device?.model || 'this device';
    if (!confirm(`Remove ${name} from this dashboard? Connected phone must scan the QR again to reappear.`)) return;
    try {
      const data = await fetch(`/api/devices/${encodeURIComponent(deviceButton.dataset.id)}`, { method: 'DELETE' })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Device remove failed');
          return body;
        });
      state.devices = data.devices || [];
      state.queue = data.queue || state.queue;
      renderAll();
    } catch (error) {
      els.sendResult.textContent = error.message;
    }
    return;
  }

  const button = event.target.closest('.deleteLog');
  if (!button) return;
  try {
    const data = await authedFetch(`/api/sms/logs/${encodeURIComponent(button.dataset.id)}`, {
      method: 'DELETE'
    });
    state.smsLogs = data.smsLogs || [];
    renderAll();
  } catch (error) {
    els.sendResult.textContent = error.message;
  }
});

els.navButtons.forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
els.showSignin.addEventListener('click', () => setAuthMode('signin'));
els.showSignup.addEventListener('click', () => setAuthMode('signup'));
els.forgotPassword.addEventListener('click', () => setAuthMode('forgot'));
els.authSubmit.addEventListener('click', async () => {
  els.authSubmit.disabled = true;
  els.authMessage.textContent = 'Please wait...';
  try {
    if (state.otpRequired) {
      if (state.authMode === 'forgot') {
        const data = await authFetch('/api/auth/forgot-password/verify-otp', {
          method: 'POST',
          body: JSON.stringify({
            email: state.otpEmail,
            otp: els.otpCode.value.trim()
          })
        });
        state.resetToken = data.resetToken || '';
        els.otpCode.value = '';
        showPasswordResetFields();
        els.authMessage.textContent = 'OTP verified. Enter your new password.';
        return;
      }
      await authFetch('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: state.otpEmail, otp: els.otpCode.value.trim() })
      });
      const session = await authFetch('/api/auth/me');
      setCurrentUser(session.user);
      hideAuthModal();
      await startDashboard();
      return;
    }
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    if (state.authMode === 'forgot' && state.resetToken) {
      await authFetch('/api/auth/forgot-password/reset', {
        method: 'POST',
        body: JSON.stringify({
          resetToken: state.resetToken,
          password: els.newPassword.value,
          confirmPassword: els.confirmPassword.value
        })
      });
      els.newPassword.value = '';
      els.confirmPassword.value = '';
      setAuthMode('signin');
      els.authMessage.textContent = 'Password changed. Please sign in with your new password.';
      return;
    }
    if (state.authMode === 'forgot') {
      const data = await authFetch('/api/auth/forgot-password/request', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      showOtp(data.email || email, 'password_reset');
      els.authMessage.textContent = 'Reset OTP sent. Please check Inbox and Spam/Promotions.';
      return;
    }
    if (state.authMode === 'signup') {
      const data = await authFetch('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ name: els.authName.value.trim(), email, password })
      });
      showOtp(data.email || email, 'signup');
      return;
    }
    const signin = await authFetch('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setCurrentUser(signin.user);
    hideAuthModal();
    await startDashboard();
  } catch (error) {
    if (error.data?.otpRequired) showOtp(error.data.email || els.authEmail.value.trim(), 'signup');
    else els.authMessage.textContent = error.message;
  } finally {
    els.authSubmit.disabled = false;
  }
});

els.resendOtp.addEventListener('click', async () => {
  try {
    await authFetch('/api/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({
        email: state.otpEmail,
        purpose: state.authMode === 'forgot' ? 'password_reset' : 'signup'
      })
    }).then((data) => {
      startOtpResendTimer(data.retryAfter || 60);
    });
    els.authMessage.textContent = 'OTP sent again. Please check Inbox and Spam/Promotions.';
  } catch (error) {
    if (error.data?.retryAfter) startOtpResendTimer(error.data.retryAfter);
    els.authMessage.textContent = error.message;
  }
});

els.logoutButton.addEventListener('click', async () => {
  await authFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});
els.addDevice.addEventListener('click', () => {
  openDevicePairingModal().catch((error) => {
    els.devicePairingResult.textContent = error.message;
  });
});
els.cancelDevicePairing.addEventListener('click', closeDevicePairingModal);
els.closeDevicePairing.addEventListener('click', closeDevicePairingModal);
els.devicePairingModal.addEventListener('click', (event) => {
  if (event.target === els.devicePairingModal) closeDevicePairingModal();
});
els.addApplication.addEventListener('click', openApplicationModal);
els.cancelApplication.addEventListener('click', closeApplicationModal);
els.applicationModal.addEventListener('click', (event) => {
  if (event.target === els.applicationModal) closeApplicationModal();
});

els.applicationsList.addEventListener('click', async (event) => {
  const regenerate = event.target.closest('.regenerateApplication');
  const remove = event.target.closest('.deleteApplication');
  try {
    if (regenerate) {
      if (!confirm('Regenerate this API key? The old key will stop working immediately.')) return;
      const data = await authedFetch(`/api/applications/${encodeURIComponent(regenerate.dataset.id)}/regenerate-key`, { method: 'POST' });
      state.applications = data.applications || [];
      renderApplications(data.application?.apiKey || '');
    }
    if (remove) {
      if (!confirm('Delete this application? Its API key will stop working immediately.')) return;
      const data = await authedFetch(`/api/applications/${encodeURIComponent(remove.dataset.id)}`, { method: 'DELETE' });
      state.applications = data.applications || [];
      renderApplications();
    }
  } catch (error) {
    els.applicationResult.textContent = error.message;
  }
});

els.createApplication.addEventListener('click', async () => {
  els.createApplication.disabled = true;
  els.applicationResult.textContent = 'Generating API key...';
  try {
    const data = await authedFetch('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: els.applicationName.value.trim() })
    });
    state.applications = data.applications || [];
    renderApplications(data.application?.apiKey || '');
    closeApplicationModal();
  } catch (error) {
    els.applicationResult.textContent = error.message;
  } finally {
    els.createApplication.disabled = false;
  }
});

els.clearLogs.addEventListener('click', async () => {
  if (!confirm('Delete all SMS logs from this dashboard?')) return;
  try {
    const data = await authedFetch('/api/sms/logs', { method: 'DELETE' });
    state.smsLogs = data.smsLogs || [];
    if (state.health) state.health = { ...state.health, smsLogCount: state.smsLogs.length };
    renderAll();
  } catch (error) {
    els.sendResult.textContent = error.message;
  }
});

function exportQuery() {
  const params = new URLSearchParams();
  if (els.filter.value.trim()) params.set('search', els.filter.value.trim());
  if (els.directionFilter.value) params.set('direction', els.directionFilter.value);
  if (els.statusFilter.value) params.set('status', els.statusFilter.value);
  if (els.applicationFilter.value) params.set('applicationId', els.applicationFilter.value);
  if (els.deviceFilter.value) params.set('deviceId', els.deviceFilter.value);
  params.set('token', state.token);
  return params;
}

function downloadExport(path) {
  const url = `${path}?${exportQuery().toString()}`;
  window.open(url, '_blank');
}

els.exportJson.addEventListener('click', () => downloadExport('/api/sms/export.json'));
els.exportCsv.addEventListener('click', () => downloadExport('/api/sms/export.csv'));

els.send.addEventListener('click', async () => {
  els.send.disabled = true;
  els.sendResult.textContent = 'Sending command to phone...';
  try {
    const response = await fetch('/api/dashboard/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        address: els.address.value.trim(),
        body: els.body.value,
        flash: els.flash.checked
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Send failed');
    els.sendResult.textContent = `Command queued: ${data.command.id}`;
  } catch (error) {
    els.sendResult.textContent = error.message;
  } finally {
    els.send.disabled = false;
  }
});

async function startDashboard() {
  await loadState();
  await Promise.all([loadApplications(), loadHealthAndQueue()]);
  connectSocket();
  startHealthQueuePolling();
}

function startHealthQueuePolling() {
  stopHealthQueuePolling();
  healthQueueInterval = setInterval(() => {
    loadHealthAndQueue().catch(() => {});
  }, 10000);
}

ensureAuthenticated().then((ok) => {
  if (!ok) return;
  return startDashboard();
}).catch((error) => {
  showAuthModal(error.message);
});
