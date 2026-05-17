import crypto from 'node:crypto';
import fs from 'node:fs';
import { connectMongo } from './mongo.js';

const DEFAULT_STATE = {
  devices: {},
  smsLogs: []
};
const MAX_SMS_LOGS_PER_USER = 10;

export class MongoStore {
  constructor({ mongoUri, dbName = 'zisk_connect', legacyFile = '' }) {
    if (!mongoUri) throw new Error('MONGODB_URI is required for server storage');
    this.mongoUri = mongoUri;
    this.dbName = dbName;
    this.legacyFile = legacyFile;
    this.runtimeCommands = [];
    this.state = structuredClone(DEFAULT_STATE);
    this.clientPromise = null;
    this.smsClearMarkers = new Map();
    this.removedDevices = new Set();
  }

  static async create(options) {
    const store = new MongoStore(options);
    await store.load();
    return store;
  }

  async db() {
    this.clientPromise ||= connectMongo(this.mongoUri);
    const client = await this.clientPromise;
    return client.db(this.dbName);
  }

  async load() {
    const database = await this.db();
    await database.collection('devices').createIndex({ id: 1 }, { unique: true });
    await database.collection('devices').createIndex({ userId: 1 });
    await database.collection('smsLogs').createIndex({ id: 1 }, { unique: true });
    await database.collection('smsLogs').createIndex({ userId: 1, timestamp: -1 });
    await database.collection('smsLogs').createIndex({ commandId: 1 }, { sparse: true });
    await database.collection('smsClearMarkers').createIndex({ userId: 1 }, { unique: true });
    await database.collection('removedDevices').createIndex({ userId: 1, rawDeviceId: 1 }, { unique: true });
    await database.collection('devicePairings').createIndex({ id: 1 }, { unique: true });
    await database.collection('devicePairings').createIndex({ token: 1 }, { unique: true });
    await database.collection('devicePairings').createIndex({ userId: 1, status: 1 });
    await database.collection('devicePairings').createIndex({ userId: 1, boundRawDeviceId: 1 });

    let [devices, smsLogs, clearMarkers, removedDevices] = await Promise.all([
      database.collection('devices').find({}).toArray(),
      database.collection('smsLogs').find({}).sort({ timestamp: -1 }).limit(1000).toArray(),
      database.collection('smsClearMarkers').find({}).toArray(),
      database.collection('removedDevices').find({}).toArray()
    ]);
    if (!devices.length && !smsLogs.length) {
      const migrated = await this.migrateLegacyJson(database);
      devices = migrated.devices;
      smsLogs = migrated.smsLogs;
    }
    this.state.devices = Object.fromEntries(devices.map(({ _id, ...device }) => [device.id, device]));
    this.state.smsLogs = smsLogs.map(({ _id, ...log }) => log);
    this.smsClearMarkers = new Map(clearMarkers.map((marker) => [marker.userId || '', Number(marker.clearedAt || 0)]));
    this.removedDevices = new Set(removedDevices.map((device) => this.removedDeviceKey(device.userId, device.rawDeviceId)));
    await this.enforceSmsLimit();
    return this.state;
  }

  async migrateLegacyJson(database) {
    if (!this.legacyFile || !fs.existsSync(this.legacyFile)) return { devices: [], smsLogs: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8').replace(/^\uFEFF/, ''));
      const devices = Object.values(parsed.devices || {});
      const smsLogs = Array.isArray(parsed.smsLogs) ? parsed.smsLogs : [];
      if (devices.length) {
        await database.collection('devices').bulkWrite(devices.map((device) => ({
          updateOne: {
            filter: { id: device.id },
            update: { $set: device },
            upsert: true
          }
        })));
      }
      if (smsLogs.length) {
        await database.collection('smsLogs').bulkWrite(smsLogs.map((log) => ({
          updateOne: {
            filter: { id: log.id },
            update: { $set: log },
            upsert: true
          }
        })));
      }
      return { devices, smsLogs };
    } catch (error) {
      console.error('Legacy JSON store migration skipped:', error.message);
      return { devices: [], smsLogs: [] };
    }
  }

  persistDevice(device) {
    this.db()
      .then((database) => database.collection('devices').updateOne(
        { id: device.id },
        { $set: device },
        { upsert: true }
      ))
      .catch((error) => console.error('Mongo device persist failed:', error.message));
  }

  persistSmsLog(log) {
    this.db()
      .then((database) => database.collection('smsLogs').updateOne(
        { id: log.id },
        { $set: log },
        { upsert: true }
      ))
      .catch((error) => console.error('Mongo SMS log persist failed:', error.message));
  }

  smsClearMarker(userId = null) {
    return this.smsClearMarkers.get(userId || '') || 0;
  }

  shouldSkipClearedSms(log) {
    const marker = this.smsClearMarker(log.userId || null);
    if (!marker) return false;
    const timestamp = Number(log.timestamp || Date.now());
    return timestamp <= marker;
  }

  async enforceSmsLimit(userId = null) {
    const users = userId
      ? [userId]
      : [...new Set(this.state.smsLogs.map((log) => log.userId || '').filter(Boolean))];
    const deleteIds = [];

    for (const currentUserId of users) {
      const userLogs = this.state.smsLogs
        .filter((log) => log.userId === currentUserId)
        .sort((a, b) => b.timestamp - a.timestamp);
      deleteIds.push(...userLogs.slice(MAX_SMS_LOGS_PER_USER).map((log) => log.id));
    }

    if (!deleteIds.length) {
      this.state.smsLogs = this.state.smsLogs.sort((a, b) => b.timestamp - a.timestamp);
      return;
    }

    const deleteSet = new Set(deleteIds);
    this.state.smsLogs = this.state.smsLogs
      .filter((log) => !deleteSet.has(log.id))
      .sort((a, b) => b.timestamp - a.timestamp);

    const database = await this.db();
    await database.collection('smsLogs').deleteMany({ id: { $in: deleteIds } });
  }

  registerDevice(device) {
    const rawDeviceId = device.rawDeviceId || device.id || crypto.randomUUID();
    const id = device.userId ? `${device.userId}:${rawDeviceId}` : rawDeviceId;
    const existing = this.state.devices[id] || {};
    this.state.devices[id] = {
      ...existing,
      ...device,
      id,
      rawDeviceId,
      displayId: existing.displayId || this.createDeviceDisplayId(),
      online: Boolean(device.online),
      removed: false,
      lastSeenAt: new Date().toISOString()
    };
    this.persistDevice(this.state.devices[id]);
    return this.state.devices[id];
  }

  createDeviceDisplayId() {
    const existing = new Set(Object.values(this.state.devices).map((device) => device.displayId).filter(Boolean));
    for (let i = 0; i < 20; i += 1) {
      const id = `ZDEV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      if (!existing.has(id)) return id;
    }
    return `ZDEV-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  async createDevicePairing(userId) {
    const pairing = {
      id: crypto.randomUUID(),
      userId,
      token: crypto.randomBytes(24).toString('hex'),
      status: 'pending',
      boundRawDeviceId: null,
      deviceId: null,
      createdAt: new Date().toISOString(),
      usedAt: null,
      removedAt: null
    };
    const database = await this.db();
    await database.collection('devicePairings').insertOne(pairing);
    return pairing;
  }

  async findDevicePairingByToken(token) {
    if (!token) return null;
    const database = await this.db();
    const pairing = await database.collection('devicePairings').findOne({ token, removedAt: null });
    if (!pairing) return null;
    const { _id, ...clean } = pairing;
    return clean;
  }

  async findDevicePairingById(id, userId = null) {
    if (!id) return null;
    const database = await this.db();
    const pairing = await database.collection('devicePairings').findOne({ id, ...(userId ? { userId } : {}) });
    if (!pairing) return null;
    const { _id, ...clean } = pairing;
    return clean;
  }

  async bindDevicePairing(pairing, rawDeviceId, deviceId) {
    if (!pairing || !rawDeviceId || !deviceId) return null;
    if (pairing.status === 'active' && pairing.boundRawDeviceId && pairing.boundRawDeviceId !== rawDeviceId) return null;
    const patch = {
      status: 'active',
      boundRawDeviceId: rawDeviceId,
      deviceId,
      usedAt: pairing.usedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const database = await this.db();
    await Promise.all([
      database.collection('devicePairings').updateMany(
        {
          userId: pairing.userId,
          boundRawDeviceId: rawDeviceId,
          id: { $ne: pairing.id },
          removedAt: null,
          status: 'active'
        },
        { $set: { status: 'replaced', removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
      ),
      database.collection('devicePairings').updateOne(
        { id: pairing.id, userId: pairing.userId, removedAt: null },
        { $set: patch }
      )
    ]);
    return { ...pairing, ...patch };
  }

  async revokeDevicePairingForDevice(deviceId, userId) {
    const database = await this.db();
    await database.collection('devicePairings').updateMany(
      { deviceId, userId, removedAt: null },
      { $set: { status: 'removed', removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
    );
  }

  async cancelDevicePairing(id, userId) {
    const database = await this.db();
    const result = await database.collection('devicePairings').updateOne(
      { id, userId, status: 'pending', removedAt: null },
      { $set: { status: 'cancelled', removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
    );
    return result.modifiedCount > 0;
  }

  removedDeviceKey(userId, rawDeviceId) {
    return `${userId || ''}:${rawDeviceId || ''}`;
  }

  isDeviceRemoved(userId, rawDeviceId) {
    if (!userId || !rawDeviceId) return false;
    return this.removedDevices.has(this.removedDeviceKey(userId, rawDeviceId));
  }

  async clearRemovedDevice(userId, rawDeviceId) {
    if (!userId || !rawDeviceId) return;
    this.removedDevices.delete(this.removedDeviceKey(userId, rawDeviceId));
    const database = await this.db();
    await database.collection('removedDevices').deleteOne({ userId, rawDeviceId });
  }

  setDeviceConnection(id, online) {
    if (!id) return null;
    const existing = this.state.devices[id] || { id, model: 'Android device' };
    this.state.devices[id] = {
      ...existing,
      id,
      online,
      lastSeenAt: new Date().toISOString()
    };
    this.persistDevice(this.state.devices[id]);
    return this.state.devices[id];
  }

  async deleteDevice(id, userId = null) {
    const device = this.state.devices[id];
    if (!device || (userId && device.userId !== userId)) return false;
    const rawDeviceId = device.rawDeviceId || device.id?.split(':').slice(1).join(':') || device.id;
    this.state.devices[id] = {
      ...device,
      online: false,
      removed: true,
      removedAt: new Date().toISOString()
    };
    if (userId && rawDeviceId) this.removedDevices.add(this.removedDeviceKey(userId, rawDeviceId));
    const database = await this.db();
    await this.revokeDevicePairingForDevice(id, userId);
    await Promise.all([
      database.collection('devices').updateOne(
        { id, ...(userId ? { userId } : {}) },
        { $set: this.state.devices[id] },
        { upsert: true }
      ),
      userId && rawDeviceId
        ? database.collection('removedDevices').updateOne(
          { userId, rawDeviceId },
          { $set: { userId, rawDeviceId, deviceId: id, removedAt: new Date() } },
          { upsert: true }
        )
        : Promise.resolve()
    ]);
    delete this.state.devices[id];
    return true;
  }

  markAllDevicesOffline() {
    let changed = false;
    for (const device of Object.values(this.state.devices)) {
      if (device.online) {
        device.online = false;
        this.persistDevice(device);
        changed = true;
      }
    }
    return changed;
  }

  upsertSms(logs) {
    const byId = new Map(this.state.smsLogs.map((item) => [item.id, item]));
    const upserted = [];
    for (const log of logs) {
      const id = log.id || crypto.randomUUID();
      const next = {
        id,
        userId: log.userId || null,
        direction: log.direction || 'unknown',
        address: log.address || '',
        body: log.body || '',
        timestamp: log.timestamp || Date.now(),
        status: log.status || 'received',
        sourceDevice: log.sourceDevice || 'android',
        applicationId: log.applicationId || null,
        applicationName: log.applicationName || '',
        assignedDeviceId: log.assignedDeviceId || null,
        deliveryStatus: log.deliveryStatus || log.status || '',
        submittedAt: log.submittedAt || null,
        sentAt: log.sentAt || null,
        deliveredAt: log.deliveredAt || null,
        resultMessage: log.resultMessage || '',
        commandId: log.commandId || null
      };
      if (this.shouldSkipClearedSms(next)) continue;
      byId.set(id, next);
      upserted.push(next);
      this.persistSmsLog(next);
    }
    this.state.smsLogs = Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
    const affectedUsers = [...new Set(upserted.map((log) => log.userId).filter(Boolean))];
    for (const userId of affectedUsers) {
      this.enforceSmsLimit(userId).catch((error) => console.error('Mongo SMS limit cleanup failed:', error.message));
    }
    return upserted;
  }

  updateSmsByCommand(commandId, patch) {
    const log = this.state.smsLogs.find((item) => item.commandId === commandId);
    if (!log) return null;
    Object.assign(log, patch);
    this.state.smsLogs = this.state.smsLogs.sort((a, b) => b.timestamp - a.timestamp);
    this.persistSmsLog(log);
    return log;
  }

  deleteSms(id, userId = null) {
    const before = this.state.smsLogs.length;
    this.state.smsLogs = this.state.smsLogs.filter((item) => item.id !== id || (userId && item.userId !== userId));
    const deleted = before !== this.state.smsLogs.length;
    if (deleted) {
      this.db()
        .then((database) => database.collection('smsLogs').deleteOne({ id, ...(userId ? { userId } : {}) }))
        .catch((error) => console.error('Mongo SMS delete failed:', error.message));
    }
    return deleted;
  }

  async clearSms(userId = null) {
    const clearedAt = Date.now();
    this.smsClearMarkers.set(userId || '', clearedAt);
    this.state.smsLogs = userId ? this.state.smsLogs.filter((item) => item.userId !== userId) : [];
    const database = await this.db();
    await database.collection('smsLogs').deleteMany(userId ? { userId } : {});
    await database.collection('smsClearMarkers').updateOne(
      { userId: userId || '' },
      { $set: { userId: userId || '', clearedAt, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  createCommand(type, payload, userId = null) {
    const command = {
      id: crypto.randomUUID(),
      userId,
      type,
      payload,
      status: 'queued',
      assignedDeviceId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null
    };
    this.runtimeCommands.unshift(command);
    this.runtimeCommands = this.runtimeCommands.slice(0, 100);
    return command;
  }

  assignCommand(commandId, deviceId) {
    const command = this.runtimeCommands.find((item) => item.id === commandId);
    if (!command) return null;
    command.status = 'pending';
    command.assignedDeviceId = deviceId;
    command.updatedAt = new Date().toISOString();
    return command;
  }

  pendingCommands(deviceId = null, userId = null) {
    return this.runtimeCommands.filter((command) =>
      command.status === 'pending' && (!deviceId || command.assignedDeviceId === deviceId) && (!userId || command.userId === userId));
  }

  queuedCommands(userId = null) {
    return this.runtimeCommands.filter((command) => command.status === 'queued' && (!userId || command.userId === userId));
  }

  activeCommands(userId = null) {
    return this.runtimeCommands.filter((command) => ['queued', 'pending'].includes(command.status) && (!userId || command.userId === userId));
  }

  isDeviceBusy(deviceId, userId = null) {
    return this.pendingCommands(deviceId, userId).length > 0;
  }

  busyDeviceIds(userId = null) {
    return new Set(this.pendingCommands(null, userId).map((command) => command.assignedDeviceId).filter(Boolean));
  }

  requeueCommandsForDevice(deviceId) {
    const requeued = [];
    for (const command of this.pendingCommands(deviceId)) {
      command.status = 'queued';
      command.assignedDeviceId = null;
      command.updatedAt = new Date().toISOString();
      requeued.push(command);
    }
    return requeued;
  }

  completeCommand(id, result) {
    const command = this.runtimeCommands.find((item) => item.id === id);
    if (!command) return null;
    command.status = result.status || 'completed';
    command.result = result;
    command.updatedAt = new Date().toISOString();
    return command;
  }
}
