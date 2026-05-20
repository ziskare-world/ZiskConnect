import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { ApplicationStore } from './applications.js';
import { createAuth } from './auth.js';
import { mongoStartupMessage } from './mongo.js';
import { MongoStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const downloadsDir = path.join(rootDir, 'downloads');
const legacyDataFile = path.join(rootDir, 'data', 'store.json');
const legacyApplicationsFile = path.join(rootDir, 'data', 'applications.json');
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
const mongoUri = process.env.MONGODB_URI || '';
const dbName = process.env.MONGODB_DB || 'zisk_connect';
const sessionSecret = process.env.SESSION_SECRET || 'zisk-connect-local-dev-session-secret-change-me';

function findAndroidApk() {
  if (!fs.existsSync(downloadsDir)) return null;
  const apks = fs.readdirSync(downloadsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.apk'))
    .map((entry) => {
      const filePath = path.join(downloadsDir, entry.name);
      const stats = fs.statSync(filePath);
      return { name: entry.name, path: filePath, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apks[0] || null;
}

let store;
let applications;
try {
  store = await MongoStore.create({ mongoUri, dbName, legacyFile: legacyDataFile });
  store.markAllDevicesOffline();
  applications = await ApplicationStore.create({ mongoUri, dbName, legacyFile: legacyApplicationsFile });
} catch (error) {
  console.error(mongoStartupMessage(error));
  process.exit(1);
}
const auth = createAuth({
  mongoUri,
  dbName,
  sessionSecret
});
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const startedAt = Date.now();
const rateBuckets = new Map();
const clients = {
  dashboards: new Set(),
  devices: new Set()
};

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api/auth', auth.router);

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

async function resolvePairingToken(token) {
  if (!token) return null;
  const pairing = await store.findDevicePairingByToken(token);
  if (pairing) {
    const user = await auth.findUserById(pairing.userId);
    return user ? {
      id: user._id.toString(),
      userCode: user.userCode,
      pairingToken: pairing.token,
      devicePairing: pairing
    } : null;
  }
  const user = await auth.findUserByPairingToken(token);
  return user ? { id: user._id.toString(), userCode: user.userCode, pairingToken: user.pairingToken, devicePairing: null } : null;
}

async function requireToken(req, res, next) {
  try {
  const token = req.header('x-pairing-token') || req.query.token;
  const pairingUser = await resolvePairingToken(token);
  if (!pairingUser) {
    res.status(401).json({ error: 'Invalid pairing token' });
    return;
  }
  req.bridgeUser = pairingUser;
  req.bridgeToken = token;
  req.devicePairing = pairingUser.devicePairing || null;
  next();
  } catch (error) {
    next(error);
  }
}

function bridgeKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest();
}

function encryptBridgeJson(value, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', bridgeKey(token), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    encrypted: true,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptBridgeJson(envelope, token) {
  if (!envelope?.encrypted) return envelope;
  if (envelope.alg && envelope.alg !== 'AES-256-GCM') throw new Error('Unsupported encryption algorithm');
  const decipher = crypto.createDecipheriv('aes-256-gcm', bridgeKey(token), Buffer.from(envelope.iv || '', 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag || '', 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data || '', 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function decryptBridgeBody(req, res, next) {
  try {
    if (!req.body?.encrypted) {
      res.status(400).json({ error: 'Encrypted bridge payload is required' });
      return;
    }
    req.body = decryptBridgeJson(req.body, req.bridgeToken);
    next();
  } catch {
    res.status(400).json({ error: 'Encrypted bridge payload could not be decrypted' });
  }
}

async function requireApiKey(req, res, next) {
  try {
    const apiKey = req.header('x-api-key') || req.query.apiKey;
    const userCode = String(req.header('x-user-code') || req.query.userCode || '').trim().toUpperCase();
    const application = applications.findByKey(apiKey);
    if (!application) {
      res.status(401).json({ error: 'Invalid application API key' });
      return;
    }
    if (!userCode) {
      res.status(401).json({ error: 'User code is required. Send it as x-user-code.' });
      return;
    }
    if (!application.userId) {
      res.status(401).json({ error: 'This application is not linked to a user. Create a new application after signing in.' });
      return;
    }
    const user = await auth.findUserById(application.userId);
    if (!user || user.userCode !== userCode) {
      res.status(401).json({ error: 'Invalid user code for this API key' });
      return;
    }
    req.application = application;
    req.bridgeUser = { id: application.userId, userCode };
    next();
  } catch (error) {
    next(error);
  }
}

function requireSendRate(req, res, next) {
  const key = req.application.id;
  const now = Date.now();
  const windowMs = 60_000;
  const max = Number(process.env.EXTERNAL_SENDS_PER_MINUTE || 30);
  const bucket = (rateBuckets.get(key) || []).filter((time) => now - time < windowMs);
  if (bucket.length >= max) {
    rateBuckets.set(key, bucket);
    res.status(429).json({ error: `Rate limit exceeded. Try again in ${Math.ceil((windowMs - (now - bucket[0])) / 1000)}s.` });
    return;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  next();
}

function sendJson(ws, event, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

function broadcast(targets, event, data) {
  for (const ws of targets) sendJson(ws, event, data);
}

function currentUserId(req) {
  return req.user?.id || req.bridgeUser?.id || null;
}

function snapshot(userId = null, pairingToken = null, userCode = null) {
  return {
    token: pairingToken || '',
    userCode: userCode || (userId ? '' : 'LEGACY'),
    port,
    host,
    lanIp: preferredLanIp(),
    addresses: localAddresses(),
    devices: devicesWithRuntimeState(userId),
    smsLogs: logsWithApplicationNames(store.state.smsLogs.filter((log) => !userId || log.userId === userId), userId),
    queue: queueSnapshot(userId),
    health: healthSnapshot(userId)
  };
}

function broadcastDashboards(userId, event, data) {
  broadcast(new Set(Array.from(clients.dashboards).filter((ws) => ws.userId === userId)), event, data);
}

function broadcastDevices(userId = null) {
  broadcastDashboards(userId, 'devices:state', devicesWithRuntimeState(userId));
}

function devicesWithRuntimeState(userId = null) {
  const busyIds = store.busyDeviceIds(userId);
  return Object.values(store.state.devices).filter((device) => !userId || device.userId === userId).map((device) => ({
    ...device,
    busy: busyIds.has(device.id),
    available: Boolean(device.online) && !busyIds.has(device.id)
  }));
}

function localAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) => (entries || [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address })));
}

function preferredLanIp() {
  return process.env.PUBLIC_HOST || localAddresses()[0]?.address || '127.0.0.1';
}

function forwardedValue(req, header) {
  return String(req.get(header) || '').split(',')[0].trim();
}

function requestScheme(req) {
  return req.query.scheme || forwardedValue(req, 'x-forwarded-proto') || req.protocol || 'http';
}

function requestHost(req) {
  const hostHeader = req.query.host || forwardedValue(req, 'x-forwarded-host') || req.get('host') || preferredLanIp();
  return String(hostHeader).replace(/^https?:\/\//, '').split('/')[0].replace(/^\[/, '').replace(/\]$/, '').split(':')[0];
}

function requestPort(req, scheme) {
  if (req.query.port) return Number(req.query.port);
  const forwardedPort = Number(forwardedValue(req, 'x-forwarded-port'));
  if (forwardedPort) return forwardedPort;
  const hostHeader = forwardedValue(req, 'x-forwarded-host') || req.get('host') || '';
  const match = String(hostHeader).match(/:(\d+)$/);
  if (match) return Number(match[1]);
  return scheme === 'https' ? 443 : port;
}

function pairingPayload(req, token = req.user.pairingToken) {
  const scheme = String(requestScheme(req)).toLowerCase() === 'https' ? 'https' : 'http';
  return {
    app: 'zisk-sms-bridge',
    userCode: req.user.userCode,
    scheme,
    host: requestHost(req),
    port: requestPort(req, scheme),
    token
  };
}

function availableDeviceSocket() {
  return availableDeviceSocketForUser(null);
}

function availableDeviceSocketForUser(userId = null) {
  return Array.from(clients.devices)
    .filter((ws) => ws.deviceId && ws.readyState === ws.OPEN && (!userId || ws.userId === userId) && !store.isDeviceBusy(ws.deviceId, userId))
    .sort((a, b) => {
      const aSeen = Date.parse(store.state.devices[a.deviceId]?.lastSeenAt || 0);
      const bSeen = Date.parse(store.state.devices[b.deviceId]?.lastSeenAt || 0);
      return aSeen - bSeen;
    })[0] || null;
}

function assignAndSend(command, ws) {
  const assigned = store.assignCommand(command.id, ws.deviceId);
  if (!assigned) return false;
  store.updateSmsByCommand(command.id, {
    status: 'assigned',
    deliveryStatus: 'assigned',
    sourceDevice: ws.deviceId,
    assignedDeviceId: ws.deviceId,
    updatedAt: Date.now()
  });
  sendJson(ws, 'command:new', encryptCommandForDevice(assigned, ws.pairingToken));
  broadcastDashboards(command.userId, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === command.userId), command.userId));
  broadcastDashboards(command.userId, 'queue:state', queueSnapshot(command.userId));
  broadcastDevices(command.userId);
  return true;
}

function encryptCommandForDevice(command, token) {
  return {
    ...command,
    payload: encryptBridgeJson(command.payload || {}, token),
    payloadEncrypted: true
  };
}

function encryptedPendingCommands(ws) {
  return store.pendingCommands(ws.deviceId, ws.userId).map((command) => encryptCommandForDevice(command, ws.pairingToken));
}

function dispatchQueuedCommands(userId = null) {
  for (const command of store.queuedCommands(userId)) {
    const ws = availableDeviceSocketForUser(command.userId);
    if (!ws) break;
    assignAndSend(command, ws);
  }
}

function handleDeviceDisconnect(ws) {
  const replacement = Array.from(clients.devices).some((client) =>
    client !== ws && client.deviceId === ws.deviceId && client.readyState === client.OPEN);
  if (replacement) {
    broadcastDevices(ws.userId);
    return;
  }
  const requeued = store.requeueCommandsForDevice(ws.deviceId);
  if (!store.state.devices[ws.deviceId]) {
    dispatchQueuedCommands(ws.userId);
    broadcastDashboards(ws.userId, 'queue:state', queueSnapshot(ws.userId));
    broadcastDevices(ws.userId);
    return;
  }
  store.setDeviceConnection(ws.deviceId, false);
  for (const command of requeued) {
    store.updateSmsByCommand(command.id, {
      status: 'queued',
      deliveryStatus: 'queued',
      resultMessage: 'Requeued because assigned phone disconnected',
      sourceDevice: 'dashboard',
      assignedDeviceId: null,
      updatedAt: Date.now()
    });
  }
  if (requeued.length) {
    broadcastDashboards(ws.userId, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === ws.userId), ws.userId));
  }
  broadcastDevices(ws.userId);
  dispatchQueuedCommands(ws.userId);
  broadcastDashboards(ws.userId, 'queue:state', queueSnapshot(ws.userId));
}

function logsWithApplicationNames(logs, userId = null) {
  return logs.map((log) => ({
    ...log,
    applicationName: log.applicationName || applications.findById(log.applicationId, userId || log.userId)?.name || ''
  }));
}

function commandSource(command) {
  const log = store.state.smsLogs.find((item) => item.commandId === command.id);
  return {
    applicationId: log?.applicationId || null,
    applicationName: log?.applicationName || '',
    address: log?.address || command.payload?.address || '',
    assignedDeviceId: command.assignedDeviceId || null
  };
}

function queueSnapshot(userId = null) {
  return store.activeCommands(userId).map((command) => ({
    ...command,
    ...commandSource(command)
  }));
}

function healthSnapshot(userId = null) {
  const devices = devicesWithRuntimeState(userId);
  return {
    host,
    port,
    lanIp: preferredLanIp(),
    addresses: localAddresses(),
    database: dbName,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    devices: {
      total: devices.length,
      online: devices.filter((device) => device.online).length,
      available: devices.filter((device) => device.available).length,
      busy: devices.filter((device) => device.busy).length,
      offline: devices.filter((device) => !device.online).length
    },
    queueSize: store.activeCommands(userId).length,
    smsLogCount: store.state.smsLogs.filter((log) => !userId || log.userId === userId).length,
    applicationCount: applications.list(userId).length
  };
}

function filterLogs(query) {
  const userId = query.userId || null;
  const direction = String(query.direction || '').trim().toLowerCase();
  const status = String(query.status || '').trim().toLowerCase();
  const applicationId = String(query.applicationId || '').trim();
  const deviceId = String(query.deviceId || '').trim();
  const search = String(query.search || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(query.limit || 1000), 1), 5000);
  return logsWithApplicationNames(store.state.smsLogs.filter((log) => !userId || log.userId === userId), userId)
    .filter((log) => !direction || String(log.direction || '').toLowerCase() === direction)
    .filter((log) => !status || String(log.status || '').toLowerCase() === status)
    .filter((log) => !applicationId || log.applicationId === applicationId)
    .filter((log) => !deviceId || log.assignedDeviceId === deviceId || log.sourceDevice === deviceId)
    .filter((log) => !search || `${log.address} ${log.body} ${log.applicationName} ${log.status}`.toLowerCase().includes(search))
    .slice(0, limit);
}

function csvEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportCsv(logs) {
  const fields = ['id', 'direction', 'address', 'body', 'timestamp', 'status', 'applicationName', 'sourceDevice', 'assignedDeviceId', 'commandId', 'resultMessage'];
  return [
    fields.join(','),
    ...logs.map((log) => fields.map((field) => csvEscape(log[field])).join(','))
  ].join('\n');
}

function createSmsCommand({ address, body, flash = false, source = 'dashboard', applicationId = null, userId = null }) {
  const application = applicationId ? applications.findById(applicationId, userId) : null;
  const command = store.createCommand(flash ? 'send_flash_sms' : 'send_sms', { address, body }, userId);
  store.upsertSms([{
    id: `command-${command.id}`,
    userId,
    direction: 'outgoing',
    address,
    body,
    timestamp: Date.now(),
    status: flash ? 'queued_flash' : 'queued',
    sourceDevice: source,
    applicationId,
    applicationName: application?.name || '',
    commandId: command.id
  }]);
  dispatchQueuedCommands(userId);
  broadcastDashboards(userId, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === userId), userId));
  broadcastDashboards(userId, 'queue:state', queueSnapshot(userId));
  broadcastDevices(userId);
  return command;
}

app.get('/api/config', auth.requireAuth, (_req, res) => {
  res.json({ pairingToken: _req.user.pairingToken, userCode: _req.user.userCode, port, host, lanIp: preferredLanIp(), addresses: localAddresses() });
});

app.get('/api/pairing', auth.requireAuth, (req, res) => {
  res.json(pairingPayload(req));
});

app.get('/api/pairing-qr.svg', auth.requireAuth, async (req, res) => {
  const payload = JSON.stringify(pairingPayload(req));
  const svg = await QRCode.toString(payload, {
    type: 'svg',
    margin: 1,
    color: {
      dark: '#071018',
      light: '#ffffff'
    }
  });
  res.type('image/svg+xml').send(svg);
});

app.post('/api/devices/pairings', auth.requireAuth, async (req, res, next) => {
  try {
    const pairing = await store.createDevicePairing(req.user.id);
    res.status(201).json({ ok: true, pairing: { id: pairing.id, status: pairing.status, createdAt: pairing.createdAt } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/devices/pairings/:id/qr.svg', auth.requireAuth, async (req, res, next) => {
  try {
    const pairing = await store.findDevicePairingById(req.params.id, req.user.id);
    if (!pairing || pairing.removedAt) {
      res.status(404).json({ error: 'Pairing invite not found' });
      return;
    }
    const svg = await QRCode.toString(JSON.stringify(pairingPayload(req, pairing.token)), {
      type: 'svg',
      margin: 1,
      color: {
        dark: '#071018',
        light: '#ffffff'
      }
    });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/devices/pairings/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const cancelled = await store.cancelDevicePairing(req.params.id, req.user.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Pending pairing invite not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/state', auth.requireAuth, (_req, res) => {
  res.json(snapshot(_req.user.id, _req.user.pairingToken, _req.user.userCode));
});

app.get('/api/downloads/android-apk', auth.requireAuth, (req, res) => {
  const apk = findAndroidApk();
  if (!apk) {
    res.status(404).json({ error: 'Android APK is not available yet. Add an APK file to server/downloads first.' });
    return;
  }
  res.download(apk.path, apk.name, (error) => {
    if (!res.headersSent && error) {
      res.status(404).json({ error: 'Android APK is not available yet. Add an APK file to server/downloads first.' });
    }
  });
});

app.get('/api/health', auth.requireAuth, (_req, res) => {
  res.json(healthSnapshot(_req.user.id));
});

app.get('/api/queue', auth.requireAuth, (_req, res) => {
  res.json({ queue: queueSnapshot(_req.user.id) });
});

app.post('/api/token/regenerate', auth.requireAuth, async (_req, res) => {
  const user = await auth.regeneratePairingToken(_req.user.id);
  const token = user.pairingToken;
  broadcastDashboards(_req.user.id, 'token:changed', { token });
  for (const ws of clients.devices) {
    if (ws.userId === _req.user.id) ws.close(4001, 'Pairing token regenerated');
  }
  res.json({ ok: true, token });
});

app.get('/api/applications', auth.requireAuth, requireToken, (_req, res) => {
  res.json({ applications: applications.list(_req.user.id) });
});

app.post('/api/applications', auth.requireAuth, requireToken, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'Application name is required' });
    return;
  }
  const application = applications.create(name, req.user.id);
  res.status(201).json({ ok: true, application, applications: applications.list(req.user.id) });
});

app.post('/api/applications/:id/regenerate-key', auth.requireAuth, requireToken, (req, res) => {
  const application = applications.regenerateKey(req.params.id, req.user.id);
  if (!application) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  res.json({ ok: true, application, applications: applications.list(req.user.id) });
});

app.delete('/api/applications/:id', auth.requireAuth, requireToken, (req, res) => {
  const deleted = applications.delete(req.params.id, req.user.id);
  if (!deleted) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  res.json({ ok: true, applications: applications.list(req.user.id) });
});

app.delete('/api/devices/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const deviceId = req.params.id;
    const device = store.state.devices[deviceId];
    if (!device || device.userId !== req.user.id) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const requeued = store.requeueCommandsForDevice(deviceId);
    for (const command of requeued) {
      store.updateSmsByCommand(command.id, {
        status: 'queued',
        deliveryStatus: 'queued',
        resultMessage: 'Requeued because phone was removed from dashboard',
        sourceDevice: 'dashboard',
        assignedDeviceId: null,
        updatedAt: Date.now()
      });
    }

    await store.deleteDevice(deviceId, req.user.id);
    for (const ws of Array.from(clients.devices)) {
      if (ws.deviceId === deviceId) ws.close(4002, 'Device removed from dashboard');
    }

    dispatchQueuedCommands(req.user.id);
    const devices = devicesWithRuntimeState(req.user.id);
    broadcastDevices(req.user.id);
    broadcastDashboards(req.user.id, 'queue:state', queueSnapshot(req.user.id));
    if (requeued.length) {
      broadcastDashboards(req.user.id, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === req.user.id), req.user.id));
    }
    res.json({ ok: true, devices, queue: queueSnapshot(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/device/register', requireToken, decryptBridgeBody, (req, res) => {
  const rawDeviceId = req.body?.id;
  const deviceId = req.bridgeUser.id && rawDeviceId ? `${req.bridgeUser.id}:${rawDeviceId}` : rawDeviceId;
  if (req.devicePairing?.status === 'active' && req.devicePairing.boundRawDeviceId && req.devicePairing.boundRawDeviceId !== rawDeviceId) {
    res.status(403).json({ error: 'Pairing token belongs to another Android device.' });
    return;
  }
  if (!req.devicePairing && store.isDeviceRemoved(req.bridgeUser.id, rawDeviceId)) {
    res.status(403).json({ error: 'Device was removed from this dashboard and cannot reconnect.' });
    return;
  }
  Promise.resolve()
    .then(async () => {
      if (req.devicePairing) {
        await store.clearRemovedDevice(req.bridgeUser.id, rawDeviceId);
        const bound = await store.bindDevicePairing(req.devicePairing, rawDeviceId, deviceId);
        if (!bound) {
          res.status(403).json({ error: 'Pairing token belongs to another Android device.' });
          return;
        }
      }
      const device = store.registerDevice({ ...(req.body || {}), userId: req.bridgeUser.id, rawDeviceId, pairingId: req.devicePairing?.id || null, online: true });
      broadcastDashboards(req.bridgeUser.id, 'device:registered', device);
      broadcastDevices(req.bridgeUser.id);
      dispatchQueuedCommands(req.bridgeUser.id);
      res.json({ ok: true, device, pendingCommands: store.pendingCommands(device.id, req.bridgeUser.id) });
    })
    .catch((error) => {
      console.error('Device register failed:', error.message);
      res.status(500).json({ error: 'Device registration failed' });
    });
});

app.post('/api/sms/sync', requireToken, decryptBridgeBody, (req, res) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs : [];
  const acceptedLogs = store.upsertSms(logs.map((log) => ({ ...log, userId: req.bridgeUser.id })));
  broadcastDashboards(req.bridgeUser.id, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === req.bridgeUser.id), req.bridgeUser.id));
  res.json({ ok: true, count: acceptedLogs.length, skipped: logs.length - acceptedLogs.length });
});

app.post('/api/sms/event', requireToken, decryptBridgeBody, (req, res) => {
  const logs = store.upsertSms([{ ...(req.body || {}), userId: req.bridgeUser.id }]);
  if (logs[0]) broadcastDashboards(req.bridgeUser.id, 'sms:event', logs[0]);
  broadcastDashboards(req.bridgeUser.id, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === req.bridgeUser.id), req.bridgeUser.id));
  res.json({ ok: true, skipped: logs.length === 0 });
});

app.get('/api/commands/pending', requireToken, (req, res) => {
  const rawDeviceId = req.query.deviceId || null;
  const deviceId = rawDeviceId && req.bridgeUser.id ? `${req.bridgeUser.id}:${rawDeviceId}` : rawDeviceId;
  res.json({ commands: store.pendingCommands(deviceId, req.bridgeUser.id) });
});

app.post('/api/commands/:id/result', requireToken, decryptBridgeBody, (req, res) => {
  const command = store.completeCommand(req.params.id, req.body || {});
  if (!command) {
    res.status(404).json({ error: 'Command not found' });
    return;
  }
  const now = Date.now();
  const patch = {
    status: command.status,
    deliveryStatus: command.status,
    resultMessage: command.result?.message || '',
    updatedAt: now
  };
  if (command.status === 'submitted') patch.submittedAt = now;
  if (command.status === 'sent') patch.sentAt = now;
  if (command.status === 'delivered') patch.deliveredAt = now;
  const updatedLog = store.updateSmsByCommand(command.id, patch);
  if (updatedLog) {
    broadcastDashboards(command.userId, 'sms:logs', logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === command.userId), command.userId));
  }
  broadcastDevices(command.userId);
  dispatchQueuedCommands(command.userId);
  broadcastDashboards(command.userId, 'queue:state', queueSnapshot(command.userId));
  res.json({ ok: true, command });
});

app.post('/api/dashboard/send', auth.requireAuth, (req, res) => {
  const { address, body, flash } = req.body || {};
  if (!address || !body) {
    res.status(400).json({ error: 'address and body are required' });
    return;
  }

  const command = createSmsCommand({ address, body, flash, source: 'dashboard', userId: req.user.id });
  res.json({ ok: true, command });
});

app.post('/api/external/sms/send', requireApiKey, requireSendRate, (req, res) => {
  const { address, body, flash } = req.body || {};
  if (!address || !body) {
    res.status(400).json({ error: 'address and body are required' });
    return;
  }

  const command = createSmsCommand({
    address,
    body,
    flash,
    source: `api:${req.application.name}`,
    applicationId: req.application.id,
    userId: req.application.userId || null
  });
  res.status(202).json({
    ok: true,
    commandId: command.id,
    status: command.status,
    assignedDeviceId: command.assignedDeviceId || null,
    queued: command.status === 'queued'
  });
});

app.get('/api/external/sms/logs', requireApiKey, (req, res) => {
  const logs = filterLogs({
    ...req.query,
    userId: req.application.userId || null,
    applicationId: req.query.applicationId || req.application.id,
    limit: req.query.limit || 50
  });
  res.json({ logs });
});

app.get('/api/sms/export.json', auth.requireAuth, (req, res) => {
  res.json({ logs: filterLogs({ ...req.query, userId: req.user.id }) });
});

app.get('/api/sms/export.csv', auth.requireAuth, (req, res) => {
  res
    .type('text/csv')
    .set('content-disposition', 'attachment; filename="zisk-connect-sms-logs.csv"')
    .send(exportCsv(filterLogs({ ...req.query, userId: req.user.id })));
});

app.delete('/api/sms/logs/:id', auth.requireAuth, (req, res) => {
  const deleted = store.deleteSms(req.params.id, req.user.id);
  if (!deleted) {
    res.status(404).json({ error: 'SMS log not found' });
    return;
  }
  const logs = logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === req.user.id), req.user.id);
  broadcastDashboards(req.user.id, 'sms:logs', logs);
  res.json({ ok: true, smsLogs: logs });
});

app.delete('/api/sms/logs', auth.requireAuth, async (_req, res, next) => {
  try {
    await store.clearSms(_req.user.id);
    const logs = logsWithApplicationNames(store.state.smsLogs.filter((log) => log.userId === _req.user.id), _req.user.id);
    broadcastDashboards(_req.user.id, 'sms:logs', logs);
    res.json({ ok: true, smsLogs: logs });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (error, _req, res, _next) => {
  console.error('API request failed:', error.message);
  if (res.headersSent) return;
  res.status(error.status || 500).json({
    error: error.message || 'Server request failed'
  });
});

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'dashboard';
  let userId = null;
  const dashboardSession = role === 'dashboard' ? auth.currentSession(req) : null;
  if (role === 'dashboard' && !dashboardSession) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (role === 'dashboard') {
    userId = dashboardSession.id || null;
  }
  if (role === 'device') {
    const rawDeviceId = url.searchParams.get('deviceId');
    const pairingUser = await resolvePairingToken(url.searchParams.get('token'));
    if (!pairingUser) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pairingUser.devicePairing?.status !== 'active' && pairingUser.devicePairing) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pairingUser.devicePairing?.boundRawDeviceId && pairingUser.devicePairing.boundRawDeviceId !== rawDeviceId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!pairingUser.devicePairing && store.isDeviceRemoved(pairingUser.id, rawDeviceId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    userId = pairingUser.id;
    req.pairingToken = pairingUser.pairingToken;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, role, url.searchParams.get('deviceId'), userId, dashboardSession, req.pairingToken || null);
  });
});

wss.on('connection', (ws, role, deviceId, userId, dashboardSession, pairingToken) => {
  const bucket = role === 'device' ? clients.devices : clients.dashboards;
  bucket.add(ws);
  ws.isAlive = true;
  ws.userId = userId || null;
  ws.rawDeviceId = deviceId;
  ws.deviceId = role === 'device' && userId && deviceId ? `${userId}:${deviceId}` : deviceId;
  ws.pairingToken = pairingToken || '';
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  if (role === 'device' && ws.deviceId) {
    for (const existing of Array.from(clients.devices)) {
      if (existing !== ws && existing.deviceId === ws.deviceId) existing.close(4000, 'Replaced by a newer connection');
    }
    store.setDeviceConnection(ws.deviceId, true);
    broadcastDevices(userId);
    dispatchQueuedCommands(userId);
  }
  sendJson(ws, 'state', role === 'device'
    ? { encrypted: true, pendingCommands: encryptedPendingCommands(ws) }
    : snapshot(userId, dashboardSession?.pairingToken, dashboardSession?.userCode));

  ws.on('close', () => {
    bucket.delete(ws);
    if (role === 'device' && ws.deviceId) {
      handleDeviceDisconnect(ws);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of [...clients.devices, ...clients.dashboards]) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, 30000);

server.on('close', () => {
  clearInterval(heartbeat);
});

server.listen(port, host, () => {
  console.log(`Dashboard: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  console.log(`Phone pairing: http://${preferredLanIp()}:${port}`);
  console.log(`Listening on: ${host}:${port}`);
});
