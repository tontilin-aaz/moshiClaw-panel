// modules/terminal.js — Terminal PTY via WebSocket
const pty = require('node-pty');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const sessions = new Map(); // sessionId → { ptyProcess, ws }

function createTerminal(ws, sessionId, cols = 120, rows = 36) {
  const shell = process.env.SHELL || '/bin/bash';

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8'
    }
  });

  sessions.set(sessionId, { ptyProcess, ws });

  // PTY → WebSocket
  ptyProcess.onData(data => {
    if (ws.readyState === 1) { // OPEN
      try {
        ws.send(data);
      } catch (e) { /* ignorar */ }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === 1) {
      ws.send(`\r\n\x1b[31m[Terminal cerrada con código ${exitCode}]\x1b[0m\r\n`);
    }
    sessions.delete(sessionId);
  });

  // Mensaje de bienvenida
  ptyProcess.write('echo "\\033[36m=== moshiClaw Panel Terminal ===\\033[0m"\r');

  return ptyProcess;
}

function handleWebSocket(ws, req, authUser) {
  const sessionId = uuidv4();
  let ptyProcess = null;

  ws.on('message', (msg) => {
    try {
      // Puede ser JSON (resize/init) o texto puro (input de teclado)
      let parsed = null;
      try { parsed = JSON.parse(msg); } catch {}

      if (parsed && parsed.type === 'init') {
        const cols = parsed.cols || 120;
        const rows = parsed.rows || 36;
        ptyProcess = createTerminal(ws, sessionId, cols, rows);
        return;
      }

      if (parsed && parsed.type === 'resize' && ptyProcess) {
        ptyProcess.resize(
          Math.max(1, parsed.cols || 80),
          Math.max(1, parsed.rows || 24)
        );
        return;
      }

      // Input de teclado directo
      if (ptyProcess) {
        const input = typeof msg === 'string' ? msg : msg.toString();
        ptyProcess.write(input);
      }

    } catch (err) {
      console.error('Terminal WS error:', err.message);
    }
  });

  ws.on('close', () => {
    const session = sessions.get(sessionId);
    if (session) {
      try { session.ptyProcess.kill(); } catch {}
      sessions.delete(sessionId);
    }
  });

  ws.on('error', (err) => {
    console.error('Terminal WS error:', err.message);
  });
}

// Ejecutar un comando y devolver salida (para la IA)
function executeCommand(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(cmd, { timeout, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (err.code || 1) : 0,
        error: err ? err.message : null
      });
    });
  });
}

module.exports = { handleWebSocket, executeCommand };
