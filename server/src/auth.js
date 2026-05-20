import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import { connectMongo } from './mongo.js';

const COOKIE_NAME = 'zisk_session';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=');
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function createSessionCookie(user, secret) {
  const payload = base64url(JSON.stringify({
    id: user._id.toString(),
    email: user.email,
    name: user.name || '',
    userCode: user.userCode || '',
    pairingToken: user.pairingToken || '',
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function readSession(req, secret) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || signature !== sign(payload, secret)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}

function clearCookie(res) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function setCookie(res, value) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function createUserCode() {
  return `ZC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function createPairingToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function createAuth({ mongoUri, dbName = 'zisk_connect', sessionSecret }) {
  const router = express.Router();
  const enabled = Boolean(mongoUri);
  let dbPromise = null;

  function db() {
    if (!enabled) throw new Error('MongoDB is not configured');
    dbPromise ||= connectMongo(mongoUri).then(async (client) => {
      const database = client.db(dbName);
      await database.collection('users').createIndex({ email: 1 }, { unique: true });
      await database.collection('users').createIndex({ userCode: 1 }, { unique: true, sparse: true });
      await database.collection('users').createIndex({ pairingToken: 1 }, { unique: true, sparse: true });
      return database;
    });
    return dbPromise;
  }

  function currentSession(req) {
    return enabled ? readSession(req, sessionSecret) : null;
  }

  async function ensureUserIdentity(user) {
    if (!enabled || (user.userCode && user.pairingToken)) return user;
    const database = await db();
    const patch = {};
    if (!user.userCode) patch.userCode = createUserCode();
    if (!user.pairingToken) patch.pairingToken = createPairingToken();
    const updated = await database.collection('users').findOneAndUpdate(
      { _id: user._id },
      { $set: patch },
      { returnDocument: 'after' }
    );
    return updated;
  }

  async function findUserByPairingToken(token) {
    if (!enabled || !token) return null;
    const database = await db();
    return database.collection('users').findOne({ pairingToken: token, verifiedAt: { $ne: null } });
  }

  async function findUserById(userId) {
    if (!enabled || !userId) return null;
    const database = await db();
    const user = await database.collection('users').findOne({ _id: new ObjectId(userId), verifiedAt: { $ne: null } });
    return user ? ensureUserIdentity(user) : null;
  }

  async function regeneratePairingToken(userId) {
    const database = await db();
    return database.collection('users').findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: { pairingToken: createPairingToken(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
  }

  async function requireAuth(req, res, next) {
    try {
      if (!enabled) {
        res.status(503).json({ error: 'MongoDB auth is not configured. Set MONGODB_URI.' });
        return;
      }
      const session = currentSession(req);
      if (!session) {
        res.status(401).json({ error: 'Sign in required' });
        return;
      }
      const database = await db();
      const user = await database.collection('users').findOne({ _id: new ObjectId(session.id), verifiedAt: { $ne: null } });
      const normalized = user ? await ensureUserIdentity(user) : null;
      if (!normalized) {
        res.status(401).json({ error: 'Sign in required' });
        return;
      }
      req.user = {
        id: normalized._id.toString(),
        email: normalized.email,
        name: normalized.name || '',
        userCode: normalized.userCode,
        pairingToken: normalized.pairingToken
      };
      next();
    } catch (error) {
      next(error);
    }
  }

  router.get('/config', (_req, res) => {
    res.json({
      enabled,
      mongoConfigured: enabled
    });
  });

  router.get('/me', async (req, res, next) => {
    try {
      const session = currentSession(req);
      if (!session) {
        res.json({ authenticated: false, user: null });
        return;
      }
      const database = await db();
      const user = await database.collection('users').findOne({ _id: new ObjectId(session.id), verifiedAt: { $ne: null } });
      const normalized = user ? await ensureUserIdentity(user) : null;
      res.json({
        authenticated: Boolean(normalized),
        user: normalized ? {
          id: normalized._id.toString(),
          email: normalized.email,
          name: normalized.name || '',
          userCode: normalized.userCode,
          pairingToken: normalized.pairingToken
        } : null
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/signup', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password || password.length < 6) {
        res.status(400).json({ error: 'Email and a 6+ character password are required' });
        return;
      }
      const database = await db();
      const existing = await database.collection('users').findOne({ email });
      if (existing) {
        res.status(409).json({ error: 'Account already exists. Please sign in.' });
        return;
      }
      await database.collection('users').insertOne({
        name,
        email,
        passwordHash: hashPassword(password),
        userCode: createUserCode(),
        pairingToken: createPairingToken(),
        createdAt: new Date(),
        updatedAt: new Date(),
        verifiedAt: new Date()
      });
      const user = await database.collection('users').findOne({ email });
      const normalized = await ensureUserIdentity(user);
      setCookie(res, createSessionCookie(normalized, sessionSecret));
      res.json({ ok: true, user: { id: normalized._id.toString(), email: normalized.email, name: normalized.name || '', userCode: normalized.userCode } });
    } catch (error) {
      if (error?.code === 11000) {
        res.status(409).json({ error: 'Account already exists. Please sign in.' });
        return;
      }
      next(error);
    }
  });

  router.post('/signin', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const database = await db();
      const user = await database.collection('users').findOne({ email });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      if (!user.verifiedAt) {
        res.status(403).json({ error: 'Account is not verified. Please create the account again or contact admin.' });
        return;
      }
      const normalized = await ensureUserIdentity(user);
      setCookie(res, createSessionCookie(normalized, sessionSecret));
      res.json({ ok: true, user: { id: normalized._id.toString(), email: normalized.email, name: normalized.name || '', userCode: normalized.userCode } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', (_req, res) => {
    clearCookie(res);
    res.json({ ok: true });
  });

  return { router, requireAuth, currentSession, findUserByPairingToken, findUserById, regeneratePairingToken };
}
