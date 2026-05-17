import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';
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

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function otpEmailText(otp, email, purpose = 'verify') {
  const action = purpose === 'password_reset' ? 'reset your Zisk Connect password' : 'verify your Zisk Connect email';
  return [
    `Your Zisk Connect verification code is ${otp}.`,
    '',
    `Use this code to ${action}. It expires in 10 minutes.`,
    `It was requested for ${email}.`,
    '',
    'If you did not request this code, you can ignore this email.'
  ].join('\n');
}

function otpEmailHtml(otp, email, purpose = 'verify') {
  const actionText = purpose === 'password_reset'
    ? 'Use this one-time code to reset your Zisk Connect password. It expires in 10 minutes.'
    : 'Use this one-time code to finish signing in to Zisk Connect. It expires in 10 minutes.';
  const heading = purpose === 'password_reset' ? 'Reset your password' : 'Verify your email';
  return `
  <div style="margin:0;padding:0;background:#f4f7fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#16202a;">
    <div style="max-width:560px;margin:0 auto;padding:28px 18px;">
      <div style="border:1px solid #dde7f0;background:#ffffff;border-radius:12px;overflow:hidden;">
        <div style="padding:22px 24px 12px;display:flex;align-items:center;gap:14px;">
          <div>
            <div style="font-size:20px;font-weight:800;color:#16202a;">Zisk Connect</div>
            <div style="font-size:13px;color:#607080;">Android SMS Bridge</div>
          </div>
        </div>
        <div style="padding:8px 24px 26px;">
          <h1 style="margin:0 0 10px;font-size:22px;color:#16202a;">${heading}</h1>
          <p style="margin:0 0 18px;color:#607080;line-height:1.55;">${actionText}</p>
          <div style="letter-spacing:7px;font-size:32px;font-weight:900;background:#eef8f7;border:1px solid #b7e1dc;border-radius:10px;text-align:center;padding:18px;color:#0f766e;">${otp}</div>
          <p style="margin:18px 0 0;color:#607080;font-size:13px;line-height:1.5;">This code was requested for ${escapeHtml(email)}. If you did not request it, you can ignore this email.</p>
        </div>
      </div>
    </div>
  </div>`;
}

function createUserCode() {
  return `ZC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function createPairingToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function createAuth({ mongoUri, dbName = 'zisk_connect', gmailUser, gmailAppPassword, sessionSecret }) {
  const router = express.Router();
  const enabled = Boolean(mongoUri);
  const mailEnabled = Boolean(gmailUser && gmailAppPassword);
  let dbPromise = null;
  let transporter = null;

  function db() {
    if (!enabled) throw new Error('MongoDB is not configured');
    dbPromise ||= connectMongo(mongoUri).then(async (client) => {
      const database = client.db(dbName);
      await database.collection('users').createIndex({ email: 1 }, { unique: true });
      await database.collection('users').createIndex({ userCode: 1 }, { unique: true, sparse: true });
      await database.collection('users').createIndex({ pairingToken: 1 }, { unique: true, sparse: true });
      await database.collection('otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await database.collection('passwordResets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return database;
    });
    return dbPromise;
  }

  function mailer() {
    if (!mailEnabled) return null;
    transporter ||= nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailAppPassword
      }
    });
    return transporter;
  }

  async function sendOtp(email, purpose = 'verify') {
    const database = await db();
    const otp = String(crypto.randomInt(100000, 1000000));
    await database.collection('otps').insertOne({
      email,
      purpose,
      otpHash: hashPassword(otp),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      usedAt: null
    });
    const transport = mailer();
    if (!transport) {
      console.log(`OTP for ${email}: ${otp}`);
      return;
    }
    await transport.sendMail({
      from: { name: 'Zisk Connect', address: gmailUser },
      to: email,
      replyTo: gmailUser,
      subject: `${otp} is your Zisk Connect verification code`,
      text: otpEmailText(otp, email, purpose),
      html: otpEmailHtml(otp, email, purpose),
      headers: {
        'X-Zisk-Connect-Purpose': 'email-verification',
        'X-Auto-Response-Suppress': 'All'
      }
    });
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
      const user = await database.collection('users').findOne({ _id: new ObjectId(session.id) });
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
      mailEnabled,
      gmailConfigured: mailEnabled,
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
      const user = await database.collection('users').findOne({ _id: new ObjectId(session.id) });
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
      if (existing?.verifiedAt) {
        res.status(409).json({ error: 'Account already exists. Please sign in.' });
        return;
      }
      await database.collection('users').updateOne(
        { email },
        {
          $set: {
            name,
            email,
            passwordHash: hashPassword(password),
            updatedAt: new Date()
          },
          $setOnInsert: {
            userCode: createUserCode(),
            pairingToken: createPairingToken(),
            createdAt: new Date(),
            verifiedAt: null
          }
        },
        { upsert: true }
      );
      await sendOtp(email, 'signup');
      res.json({ ok: true, otpRequired: true, email });
    } catch (error) {
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
        await sendOtp(email, 'signup');
        res.status(403).json({ error: 'OTP verification required', otpRequired: true, email });
        return;
      }
      const normalized = await ensureUserIdentity(user);
      setCookie(res, createSessionCookie(normalized, sessionSecret));
      res.json({ ok: true, user: { id: normalized._id.toString(), email: normalized.email, name: normalized.name || '', userCode: normalized.userCode } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/forgot-password/request', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
      }
      const database = await db();
      const user = await database.collection('users').findOne({ email, verifiedAt: { $ne: null } });
      const latestOtp = await database.collection('otps').findOne({ email, purpose: 'password_reset', usedAt: null }, { sort: { createdAt: -1 } });
      const retryAfter = latestOtp ? Math.ceil((60_000 - (Date.now() - new Date(latestOtp.createdAt).getTime())) / 1000) : 0;
      if (retryAfter > 0) {
        res.status(429).json({ error: `Please wait ${retryAfter}s before requesting another OTP.`, retryAfter });
        return;
      }
      if (user) await sendOtp(email, 'password_reset');
      res.json({ ok: true, otpRequired: true, email, retryAfter: 60 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/forgot-password/verify-otp', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const otp = String(req.body?.otp || '').trim();
      if (!email || !otp) {
        res.status(400).json({ error: 'Email and OTP are required' });
        return;
      }
      const database = await db();
      const otpDoc = await database.collection('otps').findOne({
        email,
        purpose: 'password_reset',
        usedAt: null,
        expiresAt: { $gt: new Date() }
      }, { sort: { createdAt: -1 } });
      if (!otpDoc || !verifyPassword(otp, otpDoc.otpHash)) {
        res.status(400).json({ error: 'Invalid or expired OTP' });
        return;
      }
      const user = await database.collection('users').findOne({ email, verifiedAt: { $ne: null } });
      if (!user) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }
      await database.collection('otps').updateOne({ _id: otpDoc._id }, { $set: { usedAt: new Date() } });
      const resetToken = crypto.randomBytes(32).toString('hex');
      await database.collection('passwordResets').insertOne({
        email,
        userId: user._id,
        tokenHash: hashToken(resetToken),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        usedAt: null
      });
      res.json({ ok: true, resetToken });
    } catch (error) {
      next(error);
    }
  });

  router.post('/forgot-password/reset', async (req, res, next) => {
    try {
      const resetToken = String(req.body?.resetToken || '').trim();
      const password = String(req.body?.password || '');
      const confirmPassword = String(req.body?.confirmPassword || '');
      if (!resetToken || password.length < 6 || password !== confirmPassword) {
        res.status(400).json({ error: 'New password and confirm password must match and be at least 6 characters.' });
        return;
      }
      const database = await db();
      const reset = await database.collection('passwordResets').findOne({
        tokenHash: hashToken(resetToken),
        usedAt: null,
        expiresAt: { $gt: new Date() }
      });
      if (!reset) {
        res.status(400).json({ error: 'Password reset session expired. Please request a new OTP.' });
        return;
      }
      const result = await database.collection('users').updateOne(
        { _id: reset.userId, verifiedAt: { $ne: null } },
        { $set: { passwordHash: hashPassword(password), updatedAt: new Date() } }
      );
      if (!result.matchedCount) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }
      await database.collection('passwordResets').updateOne({ _id: reset._id }, { $set: { usedAt: new Date() } });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/verify-otp', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const otp = String(req.body?.otp || '').trim();
      const database = await db();
      const otpDoc = await database.collection('otps').findOne({
        email,
        purpose: 'signup',
        usedAt: null,
        expiresAt: { $gt: new Date() }
      }, { sort: { createdAt: -1 } });
      if (!otpDoc || !verifyPassword(otp, otpDoc.otpHash)) {
        res.status(400).json({ error: 'Invalid or expired OTP' });
        return;
      }
      await database.collection('otps').updateOne({ _id: otpDoc._id }, { $set: { usedAt: new Date() } });
      const user = await database.collection('users').findOneAndUpdate(
        { email },
        { $set: { verifiedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const normalized = await ensureUserIdentity(user);
      setCookie(res, createSessionCookie(normalized, sessionSecret));
      res.json({ ok: true, user: { id: normalized._id.toString(), email: normalized.email, name: normalized.name || '', userCode: normalized.userCode } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/resend-otp', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const purpose = req.body?.purpose === 'password_reset' ? 'password_reset' : 'signup';
      if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
      }
      const database = await db();
      const latestOtp = await database.collection('otps').findOne({ email, purpose, usedAt: null }, { sort: { createdAt: -1 } });
      const retryAfter = latestOtp ? Math.ceil((60_000 - (Date.now() - new Date(latestOtp.createdAt).getTime())) / 1000) : 0;
      if (retryAfter > 0) {
        res.status(429).json({ error: `Please wait ${retryAfter}s before resending OTP.`, retryAfter });
        return;
      }
      const user = await database.collection('users').findOne({ email, verifiedAt: { $ne: null } });
      if (purpose !== 'password_reset' || user) await sendOtp(email, purpose);
      res.json({ ok: true, retryAfter: 60 });
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
