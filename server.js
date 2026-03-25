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
const browser = require('./modules/browser');
const files = require('./modules/files');
const webcam = require('./modules/webcam');
const scripts = require('./modules/scripts');
const statsHistory = require('./modules/stats_history');
const whatsapp = require('./modules/whatsapp');
const messenger = require('./modules/messenger');
const autoresponder = require('./modules/autoresponder');
const skills        = require('./modules/skills');
const canva         = require('./modules/canva');


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
    } else if (data.type === 'clear_chat') {
        ai.abortChat(data.sessionId || user.user);
        ai.clearHistory(data.sessionId || user.user);
    } else if (data.type === 'stop_chat') {
        ai.abortChat(data.sessionId || user.user);
        activeAiRequests.delete(data.sessionId || user.user);
    } else if (data.type === 'browser') {
        // Acciones de navegador
        if (data.action === 'launch') await browser.launch();
        if (data.action === 'navigate') {
            const res = await browser.navigate(data.url);
            ws.send(JSON.stringify({ type: 'browser_status', data: res }));
            // Auto-screenshot tras navegar
            const b64 = await browser.screenshot();
            if (b64) ws.send(JSON.stringify({ type: 'browser_screenshot', image: b64 }));
        }
        if (data.action === 'screenshot') {
            const b64 = await browser.screenshot();
            ws.send(JSON.stringify({ type: 'browser_screenshot', image: b64 }));
        }
        if (data.action === 'scroll') {
            const delta = data.direction === 'up' ? -600 : 600;
            await browser.scroll(delta);
            const b64 = await browser.screenshot();
            if (b64) ws.send(JSON.stringify({ type: 'browser_screenshot', image: b64 }));
        }
    }
  });

  ws.on('close', () => {
    clearInterval(statsInterval);
    activeAiRequests.delete(user.user);
    console.log(`📡 Events desconectado: ${user.user}`);
  });
});

// Initialize History
statsHistory.init(monitoring);


// ─── CHAT HANDLER ─────────────────────────────────────────────────────────────
const activeAiRequests = new Map();

async function handleChatMessage(ws, data, user) {
  const { message, provider, model, apiKey, sessionId, autoExecute, activeSkillId } = data;
  const sId = sessionId || user.user;

  if (!message || !provider || (!apiKey && provider !== 'ollama')) {
    ws.send(JSON.stringify({ type: 'chat_error', error: 'Faltan parámetros: message, provider, apiKey' }));
    return;
  }

  // El skill se lee on-demand desde ai.js cuando la IA llama read_skill()
  // Indicar que está pensando
  ws.send(JSON.stringify({ type: 'chat_thinking', sessionId: sId }));

  // Registrar solicitud activa
  activeAiRequests.set(sId, true);

  try {
    const response = await ai.chat({
      provider,
      apiKey,
      model,
      message,
      sessionId: sId,
      autoExecute: !!autoExecute,
      activeSkillId: activeSkillId || null,
      onToolCall: (toolEvent) => {
        // Verificar si la solicitud fue cancelada
        if (!activeAiRequests.has(sId)) return;

        try {
          if (toolEvent.type === 'browser_screenshot') {
            ws.send(JSON.stringify({ type: 'browser_screenshot', image: toolEvent.image }));
          } else {
            // IMPORTANTE: extraer 'type' de toolEvent para que no sobreescriba 'chat_tool'
            const { type: toolType, ...toolData } = toolEvent;
            ws.send(JSON.stringify({ type: 'chat_tool', toolType, ...toolData, sessionId: sId }));
          }
        } catch {}
      }
    });

    // Solo enviar respuesta si no fue cancelada
    if (activeAiRequests.has(sId)) {
      // Ollama devuelve { content, thinking }; otros providers devuelven string
      const content = (response && typeof response === 'object') ? response.content : (response || '');
      const thinking = (response && typeof response === 'object') ? (response.thinking || '') : '';
      ws.send(JSON.stringify({
        type: 'chat_response',
        sessionId: sId,
        content,
        thinking,
        provider
      }));
      activeAiRequests.delete(sId);
    }
  } catch (err) {
    if (activeAiRequests.has(sId)) {
      console.error('AI error:', err.message);
      ws.send(JSON.stringify({
        type: 'chat_error',
        sessionId: sId,
        error: `Error de IA: ${err.message}`
      }));
      activeAiRequests.delete(sId);
    }
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

// ─── SISTEMA (Stats/Process/Actions) ───────────────────────────────────────────
const systemRoutes = require('./routes/system');
app.use('/api', authMiddleware, systemRoutes);

// ─── SCRIPTS (Phase 4) ────────────────────────────────────────────────────────
const scriptsRoutes = require('./routes/scripts');
app.use('/api/scripts', authMiddleware, scriptsRoutes);


// ─── RUTAS DE FILES ───────────────────────────────────────────────────────────
const filesRoutes = require('./routes/files');
app.use('/api/files', authMiddleware, filesRoutes);

// ─── MENSAJERÍA AUTO-RESPONDER ────────────────────────────────────────────────

// Función unificada de envío usada por autoresponder
async function sendReply(msg, text) {
  if (msg.platform === 'whatsapp') {
    await whatsapp.sendMessage(msg.from, text);
  } else if (msg.platform === 'messenger') {
    await messenger.sendMessage(msg.conversationUrl || msg.from, text);
  }
}

// Conectar eventos de WhatsApp y Messenger al autoresponder
whatsapp.emitter.on('message', async (msg) => {
  await autoresponder.processIncomingMessage(msg, sendReply);
});
messenger.emitter.on('message', async (msg) => {
  await autoresponder.processIncomingMessage(msg, sendReply);
});

// Emitir eventos de autoresponder a todos los WS conectados
autoresponder.emitter.on('pending_response', (pending) => {
  wsEvents.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ar_pending', data: pending }));
  });
});
autoresponder.emitter.on('message_handled', (entry) => {
  wsEvents.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ar_handled', data: entry }));
  });
});
autoresponder.emitter.on('mode_changed', (mode) => {
  wsEvents.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ar_mode', mode }));
  });
});

// ─── RUTAS DE MENSAJERÍA ───────────────────────────────────────────────────────
const messagingRoutes = require('./routes/messaging');
app.use('/api/messaging', authMiddleware, messagingRoutes);

// ─── SKILLS (SKILL.md ecosystem) ─────────────────────────────────────────────
const skillsRoutes = require('./routes/skills');
app.use('/api/skills', authMiddleware, skillsRoutes);

// ─── CANVA OAuth + API ────────────────────────────────────────────────────────
const canvaRoutes = require('./routes/canva_routes')(authMiddleware);
app.use('/', canvaRoutes);

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

// Graceful shutdown & Error Handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🚨 [CRITICAL] Uncaught Exception:', err);
  // No exit here initially to avoid killing the panel forcefully, 
  // but this ensures the panel doesn't silence errors.
});

process.on('SIGTERM', () => { screen.stopStream(); server.close(); });
process.on('SIGINT', () => { screen.stopStream(); server.close(); process.exit(0); });
