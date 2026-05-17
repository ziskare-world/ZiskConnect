import crypto from 'node:crypto';
import fs from 'node:fs';
import { connectMongo } from './mongo.js';

export class ApplicationStore {
  constructor({ mongoUri, dbName = 'zisk_connect', legacyFile = '' }) {
    if (!mongoUri) throw new Error('MONGODB_URI is required for application storage');
    this.mongoUri = mongoUri;
    this.dbName = dbName;
    this.legacyFile = legacyFile;
    this.state = { applications: [] };
    this.clientPromise = null;
  }

  static async create(options) {
    const store = new ApplicationStore(options);
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
    await database.collection('applications').createIndex({ id: 1 }, { unique: true });
    await database.collection('applications').createIndex({ apiKey: 1 }, { unique: true });
    await database.collection('applications').createIndex({ userId: 1 });
    let applications = await database.collection('applications').find({}).toArray();
    if (!applications.length) {
      applications = await this.migrateLegacyJson(database);
    }
    this.state.applications = applications.map(({ _id, ...application }) => application);
    return this.state.applications;
  }

  async migrateLegacyJson(database) {
    if (!this.legacyFile || !fs.existsSync(this.legacyFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8').replace(/^\uFEFF/, ''));
      const applications = Array.isArray(parsed.applications) ? parsed.applications : [];
      if (applications.length) {
        await database.collection('applications').bulkWrite(applications.map((application) => ({
          updateOne: {
            filter: { id: application.id },
            update: { $set: application },
            upsert: true
          }
        })));
      }
      return applications;
    } catch (error) {
      console.error('Legacy JSON application migration skipped:', error.message);
      return [];
    }
  }

  persist(application) {
    this.db()
      .then((database) => database.collection('applications').updateOne(
        { id: application.id },
        { $set: application },
        { upsert: true }
      ))
      .catch((error) => console.error('Mongo application persist failed:', error.message));
  }

  list(userId = null) {
    return [...this.state.applications]
      .filter((application) => !userId || application.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  create(name, userId = null) {
    const application = {
      id: crypto.randomUUID(),
      userId,
      name: String(name || '').trim(),
      apiKey: `zisk_${crypto.randomBytes(24).toString('hex')}`,
      createdAt: new Date().toISOString()
    };
    this.state.applications.unshift(application);
    this.persist(application);
    return application;
  }

  delete(id, userId = null) {
    const before = this.state.applications.length;
    this.state.applications = this.state.applications.filter((application) => application.id !== id || (userId && application.userId !== userId));
    const deleted = before !== this.state.applications.length;
    if (deleted) {
      this.db()
        .then((database) => database.collection('applications').deleteOne({ id, ...(userId ? { userId } : {}) }))
        .catch((error) => console.error('Mongo application delete failed:', error.message));
    }
    return deleted;
  }

  regenerateKey(id, userId = null) {
    const application = this.state.applications.find((item) => item.id === id && (!userId || item.userId === userId));
    if (!application) return null;
    application.apiKey = `zisk_${crypto.randomBytes(24).toString('hex')}`;
    application.updatedAt = new Date().toISOString();
    this.persist(application);
    return application;
  }

  findById(id, userId = null) {
    return this.state.applications.find((application) => application.id === id && (!userId || application.userId === userId)) || null;
  }

  findByKey(apiKey) {
    if (!apiKey) return null;
    return this.state.applications.find((application) => application.apiKey === apiKey) || null;
  }
}
