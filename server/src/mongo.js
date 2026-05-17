import { MongoClient } from 'mongodb';

export function mongoClientOptions() {
  const options = {
    appName: 'ZiskConnect',
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000)
  };

  if (process.env.MONGODB_TLS_ALLOW_INVALID_CERTIFICATES === 'true') {
    options.tlsAllowInvalidCertificates = true;
  }

  return options;
}

export function connectMongo(mongoUri) {
  return MongoClient.connect(mongoUri, mongoClientOptions());
}

export function mongoStartupMessage(error) {
  const message = error?.message || String(error);
  const lines = [
    'MongoDB connection failed.',
    `Reason: ${message.split('\n')[0]}`,
    '',
    'Check one of these:',
    '- If using local MongoDB, set MONGODB_URI=mongodb://127.0.0.1:27017 in server/.env.',
    '- If using MongoDB Atlas, confirm your current IP is allowed in Atlas Network Access.',
    '- If using Atlas, confirm the cluster is running and the username/password in MONGODB_URI are correct.',
    '- If your network blocks MongoDB/TLS traffic, try another network or use local MongoDB.'
  ];

  if (message.includes('tlsv1 alert internal error') || message.includes('SSL routines')) {
    lines.push('', 'This specific TLS alert usually comes from Atlas/network access, not from the Express server.');
  }

  return lines.join('\n');
}
