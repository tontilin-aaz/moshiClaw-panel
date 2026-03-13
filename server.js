// server.js — Servidor principal moshiClaw Panel
require('dotenv').config();

const express = require('express');
const http    = require('http');
const https   = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs   = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { login, authMiddleware, authWebSocket } = require('./modules/auth');
const monitoring = require('./modules/monitoring');
const terminal = require('./modules/terminal');
const screen = require('./modules/screen');
const ai = require('./modules/ai');
const browser = require('./modules/browser'); // Nuevo módulo
const files = require('./modules/files'); // Modulo de archivos
const webcam = require('./modules/webcam'); // Phase 2: Webcam

const PORT = process.env.PORT || 3000;
const app = express();

// ─── HTTPS si hay certificados, si no HTTP ────────────────────────────────────
const CERT_KEY  = path.join(__dirname, 'certs', 'key.pem');
const CERT_CERT = path.join(__dirname, 'certs', 'cert.pem');
const USE_HTTPS = fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CERT);

const server = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CERT) }, app)
  : http.createServer(app);

// ─── SEGURIDAD ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Para permitir xterm.js desde CDN
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting en login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' }
});

// ─── WEBSOCKET SERVERS ────────────────────────────────────────────────────────
const wsTerminal = new WebSocket.Server({ noServer: true });
const wsScreen = new WebSocket.Server({ noServer: true });
const wsEvents = new WebSocket.Server({ noServer: true });

// Routing de WebSocket según path
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost`);
  const user = authWebSocket(req);

  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (url.pathname === '/ws/terminal') {
    wsTerminal.handleUpgrade(req, socket, head, ws => {
      wsTerminal.emit('connection', ws, req, user);
    });
  } else if (url.pathname === '/ws/screen') {
    wsScreen.handleUpgrade(req, socket, head, ws => {
      wsScreen.emit('connection', ws, req, user);
    });
  } else if (url.pathname === '/ws/events') {
    wsEvents.handleUpgrade(req, socket, head, ws => {
      wsEvents.emit('connection', ws, req, user);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// Terminal WS
wsTerminal.on('connection', (ws, req, user) => {
  console.log(`🖥️  Terminal conectada: ${user.user}`);
  terminal.handleWebSocket(ws, req, user);
});

// Screen WS
wsScreen.on('connection', (ws) => {
  console.log('📺 Screen viewer conectado');
  screen.handleWebSocket(ws);
});

// Events WS (stats + chat + notificaciones)
wsEvents.on('connection', (ws, req, user) => {
  console.log(`📡 Events conectado: ${user.user}`);

  // Enviar stats iniciales
  monitoring.getStats().then(stats => {
    if (stats) ws.send(JSON.stringify({ type: 'stats', data: stats }));
  });

  // Stats periódicos cada 2 segundos
  const statsInterval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(statsInterval);
      return;
    }
    const stats = await monitoring.getStats();
    if (stats) {
      try { ws.send(JSON.stringify({ type: 'stats', data: stats })); } catch {}
    }
  }, 2000);

  // Mensajes del cliente (chat IA, confirmaciones, navegador)
  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.type === 'chat') {
      await handleChatMessage(ws, data, user);
    } else if (data.type === 'confirm_tool') {
      await ai.executeConfirmedTool(data.confirmId, data.toolName, data.args);
    } else if (data.type === 'cancel_tool') {
      ai.cancelToolExecution(data.confirmId);
    } else if (data.type === 'browser') {
        // Acciones de navegador
        if (data.action === 'launch') await browser.launch();
        if (data.action === 'navigate') {
            const res = await browser.navigate(data.url);
            ws.send(JSON.stringify({ type: 'browser_status', data: res }));
        }
        if (data.action === 'screenshot') {
            const b64 = await browser.screenshot();
            ws.send(JSON.stringify({ type: 'browser_screenshot', image: b64 }));
        }
    }
  });

  ws.on('close', () => {
    clearInterval(statsInterval);
    console.log(`📡 Events desconectado: ${user.user}`);
  });
});

// ─── CHAT HANDLER ─────────────────────────────────────────────────────────────
async function handleChatMessage(ws, data, user) {
  const { message, provider, model, apiKey, sessionId, autoExecute } = data;

  if (!message || !provider || !apiKey) {
    ws.send(JSON.stringify({ type: 'chat_error', error: 'Faltan parámetros: message, provider, apiKey' }));
    return;
  }

  // Indicar que está pensando
  ws.send(JSON.stringify({ type: 'chat_thinking', sessionId }));

  try {
    const response = await ai.chat({
      provider,
      apiKey,
      model,
      message,
      sessionId: sessionId || user.user,
      autoExecute: !!autoExecute,
      onToolCall: (toolEvent) => {
        try {
          if (toolEvent.type === 'browser_screenshot') {
            // Enviar screenshot directamente al panel (tab Web)
            ws.send(JSON.stringify({ type: 'browser_screenshot', image: toolEvent.image }));
          } else {
            // Chat tool events (executing, result, needs_confirmation)
            ws.send(JSON.stringify({ type: 'chat_tool', ...toolEvent, sessionId }));
          }
        } catch {}
      }
    });

    ws.send(JSON.stringify({
      type: 'chat_response',
      sessionId,
      content: response,
      provider
    }));
  } catch (err) {
    console.error('AI error:', err.message);
    ws.send(JSON.stringify({
      type: 'chat_error',
      sessionId,
      error: `Error de IA: ${err.message}`
    }));
  }
}

// ─── RUTAS REST ───────────────────────────────────────────────────────────────

// Login
app.post('/api/login', loginLimiter, (req, res) => {
  console.log('--- LOGIN ATTEMPT ---');
  console.log('IP:', req.ip);
  console.log('Body:', req.body);
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }
  const result = login(username, password);
  if (result.success) {
    console.log(`✅ Login exitoso: ${username}`);
    res.json({ token: result.token });
  } else {
    console.log(`❌ Login fallido para: ${username}`);
    res.status(401).json({ error: result.error });
  }
});

// Stats (REST, para PWA offline)
app.get('/api/stats', authMiddleware, async (req, res) => {
  const stats = await monitoring.getStats();
  if (stats) res.json(stats);
  else res.status(500).json({ error: 'Error obteniendo estadísticas' });
});

// Lista de procesos
app.get('/api/processes', authMiddleware, async (req, res) => {
  const procs = await monitoring.getProcesses();
  res.json({ processes: procs });
});

// Matar proceso por PID
app.post('/api/processes/kill', authMiddleware, (req, res) => {
  const { pid } = req.body;
  if (!pid || isNaN(parseInt(pid))) {
    return res.status(400).json({ error: 'PID inválido' });
  }
  try {
    process.kill(parseInt(pid), 'SIGTERM');
    res.json({ success: true, message: `Proceso ${pid} terminado.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Captura de pantalla individual
app.get('/api/screenshot', authMiddleware, async (req, res) => {
  try {
    const b64 = await screen.takeSnapshot();
    res.json({ image: b64, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Captura de webcam (Phase 2)
app.get('/api/webcam-snap', authMiddleware, async (req, res) => {
  try {
    const b64 = await webcam.takeWebcamSnapshot();
    res.json({ image: b64, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RUTAS DE FILES ───────────────────────────────────────────────────────────
const multer = require('multer');
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      try {
          // Use safeResolve internal logic locally for multer
          const base = '/';
          const p = req.body.path || '.';
          const target = path.resolve(base, p);
          if (!target.startsWith(path.resolve(base))) throw new Error("Invalid path");
          cb(null, target);
      } catch (err) {
          cb(err);
      }
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

app.get('/api/files/list', authMiddleware, async (req, res) => {
    try {
        const items = await files.listFiles(req.query.path || '/');
        res.json({ success: true, items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/files/download', authMiddleware, (req, res) => {
    try {
        const target = files.getDownloadPath(req.query.path);
        res.download(target);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/api/files/upload', authMiddleware, upload.array('files'), (req, res) => {
    res.json({ success: true, message: "Archivos subidos correctamente." });
});

app.post('/api/files/rename', authMiddleware, async (req, res) => {
    try {
        await files.renameFile(req.body.path, req.body.newName);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/files/delete', authMiddleware, async (req, res) => {
    try {
         await files.deleteFileOrFolder(req.body.path);
         res.json({ success: true });
    } catch(err) {
         res.status(500).json({ success: false, error: err.message });
    }
});

// Health check (sin auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ─── FRONTEND ESTÁTICO ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── INICIO ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const protocol = USE_HTTPS ? 'https' : 'http';
  // Obtener IP local
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const localIP = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)?.address || 'TU_IP';

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║       🦅  MOSHICLAW PANEL  🦅            ║');
  console.log('╚════════════════════════════════════════╝');
  if (USE_HTTPS) {
    console.log(`\n🔒 Modo HTTPS activo (certificado autofirmado)`);
    console.log(`✅ getDisplayMedia() funcionará desde cualquier dispositivo`);
  } else {
    console.log(`\n⚠️  Modo HTTP — getDisplayMedia() solo funciona en localhost`);
    console.log(`   Para habilitarlo en red local, generá certificados con: ./setup.sh`);
  }
  console.log(`\n🚀 Local:     ${protocol}://localhost:${PORT}`);
  console.log(`🌐 Red local: ${protocol}://${localIP}:${PORT}`);
  console.log(`📡 WebSockets: /ws/terminal  /ws/screen  /ws/events`);
  if (USE_HTTPS) console.log(`\n⚠️  Primera vez: el navegador mostrará advertencia de cert. → Aceptá y continuá.`);
  console.log(`\n⚡ Para acceso desde internet: ngrok http ${PORT}`);
  console.log('\n🔑 Credenciales guardadas en .env\n');
});

// Graceful shutdown
process.on('SIGTERM', () => { screen.stopStream(); server.close(); });
process.on('SIGINT', () => { screen.stopStream(); server.close(); process.exit(0); });
