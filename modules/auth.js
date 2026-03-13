// modules/auth.js — Autenticación JWT
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

// Genera una contraseña aleatoria segura si no existe
function ensureCredentials() {
  let env = {};
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    lines.forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) env[k.trim()] = v.join('=').trim();
    });
  }

  let changed = false;

  if (!env.APP_PASSWORD) {
    env.APP_PASSWORD = crypto.randomBytes(16).toString('hex');
    changed = true;
    console.log('\n🔑 Contraseña generada automáticamente:');
    console.log(`   APP_PASSWORD = ${env.APP_PASSWORD}\n`);
  }

  if (!env.JWT_SECRET) {
    env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    changed = true;
  }

  if (!env.APP_USER) {
    env.APP_USER = 'agus';
    changed = true;
  }

  if (changed) {
    const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  }

  return env;
}

const credentials = ensureCredentials();
// Recargamos dotenv después de asegurar que existen
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || credentials.JWT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD || credentials.APP_PASSWORD;
const APP_USER = process.env.APP_USER || credentials.APP_USER || 'agus';

function login(username, password) {
  if (username === APP_USER && password === APP_PASSWORD) {
    const token = jwt.sign(
      { user: username, iat: Date.now() },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    return { success: true, token };
  }
  return { success: false, error: 'Credenciales inválidas' };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Middleware Express
function authMiddleware(req, res, next) {
  let token;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  req.user = decoded;
  next();
}

// Para WebSocket — token en query string
function authWebSocket(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return null;
  return verifyToken(token);
}

module.exports = { login, verifyToken, authMiddleware, authWebSocket, APP_PASSWORD, APP_USER };
