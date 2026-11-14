'use strict';
/**
 * Backend de laboratorio – S08 | AP6
 * ---------------------------------------------------------------------------
 * Demuestra que la configuración llega al contenedor desde Kubernetes:
 *   - ConfigMap (app-config): DB_HOST, DB_NAME, APP_PORT
 *   - Secret    (db-secret) : DB_USER, DB_PASS
 * y que el backend se comunica con MongoDB a través del Service ClusterIP.
 *
 * Endpoints:
 *   GET /           -> información general del servicio
 *   GET /live       -> liveness: el proceso está vivo (no depende de la BD)
 *   GET /health     -> readiness + demo: estado de la BD y de las variables
 *   GET /api/status -> alias de /health
 *   GET /api/visits -> incrementa y devuelve un contador guardado en MongoDB
 */
const express = require('express');
const { MongoClient } = require('mongodb');

// ---------------------------------------------------------------------------
// 1. Lectura de variables de entorno (inyectadas por envFrom en el Deployment)
// ---------------------------------------------------------------------------
const REQUIRED_VARS = ['DB_HOST', 'DB_NAME', 'APP_PORT', 'DB_USER', 'DB_PASS'];
const SECRET_VARS = new Set(['DB_USER', 'DB_PASS']);

const config = {
  dbHost: process.env.DB_HOST,
  dbName: process.env.DB_NAME,
  port: parseInt(process.env.APP_PORT, 10) || 3000,
  dbUser: process.env.DB_USER,
  dbPass: process.env.DB_PASS,
};

/** Devuelve qué variables existen. NUNCA expone valores de las credenciales. */
function describeVariables() {
  const report = {};
  for (const name of REQUIRED_VARS) {
    const present = Boolean(process.env[name]);
    report[name] = {
      loaded: present,
      source: SECRET_VARS.has(name) ? 'Secret (db-secret)' : 'ConfigMap (app-config)',
      // Valores públicos se muestran; los del Secret se enmascaran.
      value: !present ? null : SECRET_VARS.has(name) ? '********' : process.env[name],
    };
  }
  return report;
}

const missingVars = REQUIRED_VARS.filter((n) => !process.env[n]);
if (missingVars.length > 0) {
  console.warn(`[config] Variables faltantes: ${missingVars.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2. Conexión a MongoDB con reintentos (MongoDB puede tardar en estar listo)
// ---------------------------------------------------------------------------
// encodeURIComponent evita que caracteres especiales de la contraseña rompan la URI.
// authSource=admin: el usuario root se crea en la BD "admin" (MONGO_INITDB_ROOT_*).
function buildMongoUri() {
  const user = encodeURIComponent(config.dbUser || '');
  const pass = encodeURIComponent(config.dbPass || '');
  return `mongodb://${user}:${pass}@${config.dbHost}:27017/${config.dbName}?authSource=admin`;
}

let client = null;
let db = null;
let dbState = { connected: false, lastError: null, lastCheck: null };

async function connectWithRetry(attempt = 1) {
  const delayMs = Math.min(2000 * attempt, 10000); // backoff lineal con tope de 10 s
  try {
    client = new MongoClient(buildMongoUri(), { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(config.dbName);
    await db.command({ ping: 1 });
    dbState = { connected: true, lastError: null, lastCheck: new Date().toISOString() };
    console.log(`[db] Conectado a MongoDB (${config.dbHost}/${config.dbName})`);
  } catch (err) {
    dbState = { connected: false, lastError: err.message, lastCheck: new Date().toISOString() };
    console.error(`[db] Intento ${attempt} fallido: ${err.message}. Reintento en ${delayMs} ms`);
    if (client) await client.close().catch(() => {});
    setTimeout(() => connectWithRetry(attempt + 1), delayMs);
  }
}

/** Verifica el estado real de la conexión (ping) en cada consulta de salud. */
async function checkDb() {
  if (!db) return false;
  try {
    await db.command({ ping: 1 });
    dbState = { connected: true, lastError: null, lastCheck: new Date().toISOString() };
  } catch (err) {
    dbState = { connected: false, lastError: err.message, lastCheck: new Date().toISOString() };
  }
  return dbState.connected;
}

// ---------------------------------------------------------------------------
// 3. API HTTP
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (_req, res) => {
  res.json({
    service: 'backend-s08',
    description: 'Laboratorio S08 | AP6 – ConfigMap + Secret + NodePort en Minikube',
    pod: process.env.HOSTNAME, // nombre del Pod: útil para ver el balanceo entre réplicas
    endpoints: ['/live', '/health', '/api/status', '/api/visits'],
  });
});

app.get('/live', (_req, res) => res.status(200).json({ status: 'alive' }));

async function healthHandler(_req, res) {
  const connected = await checkDb();
  const configOk = missingVars.length === 0;
  const healthy = connected && configOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'UP' : 'DEGRADED',
    pod: process.env.HOSTNAME,
    timestamp: new Date().toISOString(),
    configuration: {
      allVariablesLoaded: configOk,
      missing: missingVars,
      variables: describeVariables(),
    },
    database: {
      host: config.dbHost,
      name: config.dbName,
      connected,
      lastError: dbState.lastError,
    },
  });
}
app.get('/health', healthHandler);
app.get('/api/status', healthHandler);

app.get('/api/visits', async (_req, res) => {
  if (!(await checkDb())) {
    return res.status(503).json({ error: 'Sin conexión a MongoDB' });
  }
  try {
    const result = await db
      .collection('visits')
      .findOneAndUpdate(
        { _id: 'counter' },
        { $inc: { total: 1 }, $set: { lastPod: process.env.HOSTNAME, lastVisit: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
    res.json({ visits: result.total, lastPod: result.lastPod });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. Arranque y apagado ordenado (SIGTERM lo envía Kubernetes al terminar el Pod)
// ---------------------------------------------------------------------------
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[http] Escuchando en el puerto ${config.port}`);
  connectWithRetry();
});

function shutdown(signal) {
  console.log(`[sys] ${signal} recibido. Cerrando...`);
  server.close(async () => {
    if (client) await client.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref(); // forzar salida si algo se cuelga
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
