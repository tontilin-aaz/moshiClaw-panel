// ═══════════════════════════════════════════════════════════════════════════════
//  MOSHICLAW PANEL — App Logic
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URL = window.location.origin;
const WS_BASE = BASE_URL.replace(/^http/, 'ws');

let authToken = localStorage.getItem('oc_token') || null;
let settings       = JSON.parse(localStorage.getItem('oc_settings') || '{}');
let activeSkillId   = localStorage.getItem('oc_active_skill') || null;
let activeSkillMeta = JSON.parse(localStorage.getItem('oc_active_skill_meta') || 'null');
let _cachedSkills   = [];
let chatHistory = JSON.parse(localStorage.getItem('oc_chat') || '[]');
// chatSessionId persistido para que el servidor recuerde el contexto entre recargas
let chatSessionId = localStorage.getItem('oc_session_id') || ('session_' + Date.now());
localStorage.setItem('oc_session_id', chatSessionId);
if (!localStorage.getItem('oc_session_id')) localStorage.setItem('oc_session_id', chatSessionId);
let eventsWS = null;
let terminalWS = null;
let screenWS = null;
let xterm = null;
let fitAddon = null;
let cpuChart = null;
let ramChart = null;
let screenActive = false;
let screenFpsCounter = 0;
let screenStream = null;
let lastFpsTime = Date.now();
let autoExec = settings.autoExec || false;

// ─── UTILS ────────────────────────────────────────────────────────────────────
function qs(sel) { return document.querySelector(sel); }
function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

// ─── THEME ────────────────────────────────────────────────────────────────────
const TERM_THEMES = {
  dark: {
    background: '#0d0d0d', foreground: '#e2e8f0', cursor: '#00d4ff',
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#bfbfbf'
  },
  light: {
    background: '#ebe4d6', foreground: '#1c1917', cursor: '#2563eb',
    black: '#44403c', red: '#dc2626', green: '#059669', yellow: '#d97706',
    blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#f5f0e8'
  }
};
const CC_TERM_THEMES = {
  dark: {
    background: '#0d0d0d', foreground: '#e2e8f0', cursor: '#a855f7',
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#bfbfbf'
  },
  light: {
    background: '#ebe4d6', foreground: '#1c1917', cursor: '#7c3aed',
    black: '#44403c', red: '#dc2626', green: '#059669', yellow: '#d97706',
    blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#f5f0e8'
  }
};
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = qs('#btn-theme i');
  if (icon) { icon.setAttribute('data-lucide', theme === 'light' ? 'moon' : 'sun'); lucide.createIcons(); }
  localStorage.setItem('oc_theme', theme);
  // Actualizar terminales normales
  if (typeof terminals !== 'undefined') {
    Object.values(terminals).forEach(t => t.x.options.theme = TERM_THEMES[theme] || TERM_THEMES.dark);
  }
  // Actualizar terminales de Claude Code agents
  if (typeof ccAgents !== 'undefined') {
    Object.values(ccAgents).forEach(a => a.term.options.theme = CC_TERM_THEMES[theme] || CC_TERM_THEMES.dark);
  }
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
}
// Aplicar tema guardado al cargar
(function() { const saved = localStorage.getItem('oc_theme'); if (saved) applyTheme(saved); })();

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function forceReloadCache() {
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
  }
  if (window.caches) {
    caches.keys().then(names => names.forEach(n => caches.delete(n)));
  }
  localStorage.clear();
  sessionStorage.clear();
  window.location.href = window.location.pathname + '?reload=' + Date.now();
}

async function doLogin() {
  const user = qs('#login-user').value.trim();
  const pass = qs('#login-pass').value;
  const btn = qs('#btn-login');
  
  if (!user || !pass) {
    qs('#login-error').textContent = 'Completá ambos campos';
    return;
  }
  
  qs('#login-error').textContent = '';
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      authToken = data.token;
      localStorage.setItem('oc_token', authToken);
      showApp();
    } else {
      qs('#login-error').textContent = data.error || 'Error de login';
    }
  } catch (e) {
    qs('#login-error').textContent = 'No se pudo conectar al servidor';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function logout() {
  authToken = null;
  localStorage.removeItem('oc_token');
  disconnectAll();
  qs('#app').classList.remove('visible');
  qs('#login-screen').style.display = 'flex';
  qs('#login-pass').value = '';
}

// ─── APP INIT ─────────────────────────────────────────────────────────────────
function showApp() {
  qs('#login-screen').style.display = 'none';
  qs('#app').classList.add('visible');
  initCharts();
  connectEvents();
  // Restaurar historial de chat (persiste al backgroundear/recargar)
  if (chatHistory.length) {
    const container = qs('#chat-messages');
    chatHistory.forEach(m => {
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      if (m.role === 'assistant') {
        el.innerHTML = renderMarkdown(m.content);
      } else {
        el.textContent = m.content;
      }
      container.appendChild(el);
    });
    const last = container.lastChild;
    if (last) last.scrollIntoView();
  }
  if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
  }
  switchPanel('chat');
}

function init() {
  // Bindings
  qs('#btn-login').addEventListener('click', doLogin);
  qs('#login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  qs('#login-user').addEventListener('keydown', e => { if (e.key === 'Enter') qs('#login-pass').focus(); });
  qs('#btn-logout').addEventListener('click', logout);
  qs('#btn-settings').addEventListener('click', openSettings);
  if (activeSkillMeta) updateSkillBadge(); // Restaurar skill badge al cargar
  qs('#btn-close-settings').addEventListener('click', closeSettings);
  qs('#btn-save-settings').addEventListener('click', saveSettings);
  
  const btnSend = qs('#btn-send-chat');
  const handleSend = (e) => {
    e.preventDefault();
    if (!btnSend.disabled) sendChatMessage();
  };
  btnSend.addEventListener('click', handleSend);
  btnSend.addEventListener('mousedown', e => e.preventDefault());
  btnSend.addEventListener('touchstart', handleSend, { passive: false });
  
  qs('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // Auto-resize textarea
  qs('#chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Global focus listeners to detect virtual keyboard opening
  document.addEventListener('focusin', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      document.body.classList.add('keyboard-open');
    }
  });
  document.addEventListener('focusout', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      document.body.classList.remove('keyboard-open');
    }
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
  });

  // More Menu Logic
  // (Logic handled below in the document click listener for outside-click support)


  // Model select logic
  qs('#cfg-model-select').addEventListener('change', (e) => {
    const isCustom = e.target.value === 'custom';
    qs('#manual-model-group').style.display = isCustom ? 'block' : 'none';
  });
  document.addEventListener('click', e => {
     const menu = qs('#more-menu');
     const btn = qs('#btn-more-menu');
     if (btn && btn.contains(e.target)) {
         menu.classList.toggle('open');
     } else if (menu && !menu.contains(e.target) && menu.classList.contains('open')) {
         menu.classList.remove('open');
     }
  });

  document.querySelectorAll('.more-item').forEach(btn => {
     btn.addEventListener('click', () => {
         switchPanel(btn.dataset.panel);
         qs('#more-menu').classList.remove('open');
     });
  });

  // Toggle autoexec
  const toggleEl = qs('#toggle-autoexec');
  if (autoExec) toggleEl.classList.add('on');
  toggleEl.addEventListener('click', () => {
    autoExec = !autoExec;
    toggleEl.classList.toggle('on', autoExec);
  });

  // Toggle Claude Code (visual only — saved on btn-save-settings)
  const toggleCC = qs('#toggle-claudecode');
  if (toggleCC) {
    toggleCC.addEventListener('click', () => {
      toggleCC.classList.toggle('on');
    });
  }

  // Aplicar setting de Claude Code al iniciar
  applyClaudeCodeSetting();

  // Restaurar settings
  if (settings.provider) qs('#cfg-provider').value = settings.provider;
  if (settings.apiKey) qs('#cfg-apikey').value = settings.apiKey;
  
  if (settings.model) {
      const modelSelect = qs('#cfg-model-select');
      let found = false;
      for (let opt of modelSelect.options) {
          if (opt.value === settings.model) {
              modelSelect.value = settings.model;
              found = true;
              break;
          }
      }
      if (!found) {
          modelSelect.value = 'custom';
          qs('#cfg-model').value = settings.model;
          qs('#manual-model-group').style.display = 'block';
      }
  }

  // Auto-login si hay token
  if (authToken) showApp();

  // SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});

    // Cuando el usuario toca una notificación de agente, el SW manda este mensaje
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'cc_notification_click') {
        const agentId = event.data.agentId;
        switchPanel('claudecode');
        if (agentId && ccAgents.has(agentId)) {
          ccSelectAgent(agentId);
          ccShowTerminal();
        }
      }
    });
  }
  
  // Create Lucide Icons
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Jarvis voice
  initJarvis();

  // Reiniciar escucha JARVIS + WebSocket al volver a la app (móvil / iOS PWA)
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible') {
        logDebug("📱 App Visible - Reiniciando...");
        if (_keepAliveCtx && _keepAliveCtx.state === 'suspended') _keepAliveCtx.resume().catch(() => {});

        // ── Reconexión inmediata del WebSocket si iOS lo cerró en segundo plano ──
        if (!eventsWS || eventsWS.readyState === WebSocket.CLOSED || eventsWS.readyState === WebSocket.CLOSING) {
          logDebug("📡 WS caído, reconectando...");
          connectEvents();
        }

        // Timeout para que el sistema operativo libere el micro si estaba en uso
        setTimeout(() => {
          if (jarvisMode && !jarvisCapturing && !jarvisRec) {
            jarvisBadge('wake', 'JARVIS escuchando...');
            startWakeListener();
          }
        }, 800);
      } else {
        logDebug("📱 App Background - Deteniendo micro...");
        stopWakeListener();
        // Forzar limpieza de cualquier instancia colgada
        if (jarvisRec) { try { jarvisRec.abort(); } catch(e){} jarvisRec = null; }
      }
    } catch (err) {
      logDebug("Visibility Error: " + err.message);
    }
  });

  // Global Error Handler for Mobile
  window.onerror = (msg, url, line) => {
    logDebug("🔥 Error: " + msg + " at line " + line);
  };
}

function logDebug(msg) {
  const dc = qs('#debug-console');
  if (!dc) return;
  const entry = document.createElement('div');
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  dc.appendChild(entry);
  dc.scrollTop = dc.scrollHeight;
  console.log("DEBUG:", msg);
}

function toggleDebugConsole() {
  const dc = qs('#debug-console');
  dc.classList.toggle('visible');
  if (dc.classList.contains('visible') && !qs('#btn-test-sound')) {
    const btn = document.createElement('button');
    btn.id = 'btn-test-sound';
    btn.textContent = '🔊 PROBAR SONIDO (BEEP)';
    btn.style = 'background:#10b981; color:white; border:none; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; cursor:pointer; font-weight:bold; width:100%; display:block;';
    btn.onclick = () => {
      playTestBeep();
      _doSpeak("Probando sistema de voz.", 1.0, 1.0);
    };

    const btnVoices = document.createElement('button');
    btnVoices.id = 'btn-list-voices';
    btnVoices.textContent = '🎙️ VER VOCES DISPONIBLES';
    btnVoices.style = 'background:#6366f1; color:white; border:none; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; cursor:pointer; font-weight:bold; width:100%; display:block;';
    btnVoices.onclick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) { logDebug("⚠️ Sin voces cargadas aún"); return; }
      logDebug("── VOCES EN ESTE DISPOSITIVO ──");
      voices.forEach((v, i) => logDebug(`${i+1}. ${v.name} [${v.lang}]${v.default ? ' ★' : ''}`));
      logDebug(`── VOZ JARVIS ACTUAL: ${jarvisVoice ? jarvisVoice.name : 'ninguna'} ──`);
    };

    const btnCopyVoices = document.createElement('button');
    btnCopyVoices.id = 'btn-copy-voices';
    btnCopyVoices.textContent = '📋 COPIAR LISTA DE VOCES';
    btnCopyVoices.style = 'background:#f59e0b; color:white; border:none; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:12px; cursor:pointer; font-weight:bold; width:100%; display:block;';
    btnCopyVoices.onclick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) { logDebug("⚠️ Sin voces cargadas aún"); return; }
      const txt = voices.map((v, i) => `${i+1}. ${v.name} [${v.lang}]${v.default ? ' ★' : ''}`).join('\n')
        + `\n\nJARVIS usa: ${jarvisVoice ? jarvisVoice.name : 'ninguna'}`;
      navigator.clipboard.writeText(txt)
        .then(() => logDebug("✅ Lista copiada al portapapeles"))
        .catch(() => logDebug("❌ No se pudo copiar (permiso denegado)"));
    };

    dc.prepend(btnCopyVoices);
    dc.prepend(btnVoices);
    dc.prepend(btn);
  }
}

function playTestBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    logDebug("🎵 Beep de prueba enviado...");
  } catch (err) {
    logDebug("❌ Beep Error: " + err.message);
  }
}

// ─── PANEL SWITCHING ──────────────────────────────────────────────────────────
function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn[data-panel]').forEach(b => {
    b.classList.toggle('active', b.dataset.panel === name);
  });
  
  // Highlight the More Menu button if a hidden panel is active
  const isHiddenPanel = ['terminal', 'screen', 'browser', 'webcam', 'messaging', 'canva'].includes(name);
  qs('#btn-more-menu').classList.toggle('active', isHiddenPanel);

  const panel = qs(`#panel-${name}`);
  if (panel) panel.classList.add('active');

  if (name === 'terminal') initTerminal();
  if (name === 'claudecode') initClaudeCode();
  if (name === 'screen') initScreen();
  if (name === 'monitor') {
      loadProcesses();
      loadHealthHistory();
  }
  if (name === 'scripts') loadScripts();
  if (name === 'messaging') refreshMessagingStatus();
  if (name === 'canva') refreshCanvaStatus();
  if (name === 'files') {
      if (!fmInitialized) {
          qs('#fm-path').value = '/';
          fmLoad();
          fmInitialized = true;
      } else {
          fmLoad(); // Refresh on every visit
      }
  }
  if (name === 'webcam') {
      if (typeof initWebcam === 'function') initWebcam();
  }
  if (name !== 'screen' && typeof screenActive !== 'undefined' && screenActive) {
      if (typeof pauseScreen === 'function') pauseScreen();
  }
  if (name !== 'webcam' && typeof webcamActive !== 'undefined' && webcamActive) {
      if (typeof pauseWebcam === 'function') pauseWebcam();
  }
}

// ─── WEBSOCKET: EVENTS ────────────────────────────────────────────────────────
function connectEvents() {
  if (eventsWS) eventsWS.close();
  const dot = qs('#conn-dot');

  eventsWS = new WebSocket(`${WS_BASE}/ws/events?token=${authToken}`);

  eventsWS.onopen = () => {
    dot.classList.remove('offline');
    console.log('Events WS connected');
    // Si la UI quedó atascada en "pensando" (por desconexión), resetearla
    if (pendingThinkingEl) {
      removeThinking();
      qs('#btn-send-chat').disabled = false;
      addMessage('🔄 Reconectado. Si esperabas una respuesta, el agente puede haber terminado mientras estabas desconectado. Podés preguntar "¿qué hiciste?" para continuar.', 'system');
    }
  };

  eventsWS.onclose = () => {
    dot.classList.add('offline');
    setTimeout(connectEvents, 3000); // Reconectar
  };

  eventsWS.onerror = () => { dot.classList.add('offline'); };

  eventsWS.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'stats') updateStats(msg.data);
    else if (msg.type === 'chat_thinking') showThinking(msg.sessionId);
    else if (msg.type === 'chat_response') showResponse(msg.content, msg.provider, msg.thinking);
    else if (msg.type === 'chat_error') showChatError(msg.error);
    else if (msg.type === 'chat_tool') { removeThinking(); handleToolEvent(msg); }
    else if (msg.type === 'browser_status') {
        eventsWS.send(JSON.stringify({ type: 'browser', action: 'screenshot' }));
    }
    else if (msg.type === 'browser_screenshot') {
        updateBrowserScreenshot(msg.image);
    }
  };
}

let lastNotifTime = 0;

// ─── PROCESS MANAGER ─────────────────────────────────────────────────────────
async function loadProcesses() {
  try {
    const res = await fetch('/api/processes', { headers: { 'Authorization': 'Bearer ' + authToken } });
    const data = await res.json();
    renderProcesses(data.processes || []);
  } catch(err) {
    console.error('Error cargando procesos:', err);
  }
}

function renderProcesses(procs) {
  const list = qs('#proc-list');
  if (!list) return;
  if (!procs.length) {
    list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:10px;font-size:12px">No hay procesos activos detectados</div>';
    return;
  }
  list.innerHTML = procs.map(p => `
    <div class="proc-row">
      <span class="proc-name" title="PID: ${p.pid}">${p.name}</span>
      <span class="proc-cpu">${(p.cpu || 0).toFixed(1)}%</span>
      <span class="proc-mem">${(p.mem || 0).toFixed(1)}%</span>
      <button class="proc-kill" onclick="killProcess(${p.pid})">✕</button>
    </div>
  `).join('');
}

async function killProcess(pid) {
  if (!confirm(`¿Seguro que querés terminar el proceso PID ${pid}?`)) return;
  try {
    const res = await fetch('/api/processes/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body: JSON.stringify({ pid })
    });
    const data = await res.json();
    if (data.success) {
      setTimeout(loadProcesses, 1000); // Reload after 1s
    } else {
      alert('Error: ' + data.error);
    }
  } catch(err) { alert('Request error'); }
}

async function quickAction(type) {
  if (type === 'notify') {
    if (Notification.permission === 'granted') {
      new Notification('🔔 moshiClaw', { body: 'Prueba de notificación exitosa' });
    } else {
      Notification.requestPermission();
    }
    return;
  }
  
  if (!confirm(`¿Ejecutar acción: ${type}?`)) return;
  
  try {
    const res = await fetch(`/api/system/${type}`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken }
    });
    const data = await res.json();
    if (data.success) {
        alert(data.message || 'Acción ejecutada con éxito.');
        if (type === 'reboot' || type === 'shutdown') {
            // Indicar que se perderá la conexión
            document.body.innerHTML = `<div style="display:flex; height:100vh; align-items:center; justify-content:center; flex-direction:column; background:#000; color:#fff;">
                <h1 style="color:var(--accent)">${type === 'reboot' ? 'Reiniciando...' : 'Apagando...'}</h1>
                <p>La conexión se ha cerrado.</p>
            </div>`;
        }
    } else {
        alert('Error: ' + data.error);
    }
  } catch(e) { alert('Error al enviar acción directa al sistema'); }
}
// ─── SCRIPT VAULT (Phase 4) ──────────────────────────────────────────────────
async function loadScripts() {
    try {
        const res = await fetch('/api/scripts', { headers: { 'Authorization': 'Bearer ' + authToken } });
        const data = await res.json();
        renderScripts(data.scripts || []);
    } catch(err) { console.error(err); }
}

function renderScripts(scripts) {
    const list = qs('#scripts-list');
    if (!list) return;
    if (!scripts.length) {
        list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px;font-size:12px">Tu bóveda está vacía</div>';
        return;
    }
    list.innerHTML = scripts.map(s => `
        <div class="script-item">
            <div class="script-name">${s.name}<div class="script-cmd-hint">${s.cmd}</div></div>
            <div style="display:flex; gap:8px;">
                <button class="btn-run" onclick="runScript(${s.id})"><i data-lucide="play"></i> RUN</button>
                <button class="icon-btn" onclick="deleteScript(${s.id})" style="border-color:var(--red); color:var(--red); width:32px; height:32px;"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
    `).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function runScript(id) {
    const outBox = qs('#script-output-box');
    const outText = qs('#script-output');
    outBox.style.display = 'block';
    outText.textContent = '> Ejecutando script...\n';
    
    try {
        const res = await fetch('/api/scripts/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        outText.textContent += data.output || 'Finalizado sin salida.';
        if (data.exitCode !== 0) outText.textContent += `\n[Error con código ${data.exitCode}]`;
    } catch(err) {
        outText.textContent += 'Error de red al ejecutar.';
    }
}

function showAddScript() {
    qs('#script-modal').classList.add('open');
}

async function saveNewScript() {
    const name = qs('#script-name').value.trim();
    const cmd = qs('#script-cmd').value.trim();
    if (!name || !cmd) return alert('Faltan datos');
    
    try {
        const res = await fetch('/api/scripts/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ name, cmd })
        });
        const data = await res.json();
        if (data.success) {
            qs('#script-modal').classList.remove('open');
            qs('#script-name').value = '';
            qs('#script-cmd').value = '';
            loadScripts();
        }
    } catch(err) { alert('Error al guardar'); }
}

async function deleteScript(id) {
    if (!confirm('¿Seguro que querés borrar este script?')) return;
    try {
        await fetch(`/api/scripts/${id}`, { 
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + authToken } 
        });
        loadScripts();
    } catch(err) { console.error(err); }
}

// ─── HEALTH HISTORY (Phase 4) ────────────────────────────────────────────────
let historyChart = null;

async function loadHealthHistory() {
    try {
        const res = await fetch('/api/stats/history', { headers: { 'Authorization': 'Bearer ' + authToken } });
        const data = await res.json();
        renderHistoryChart(data.history || []);
    } catch(err) { console.error(err); }
}

function renderHistoryChart(history) {
    const ctx = qs('#chart-history').getContext('2d');
    const labels = history.map(h => new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const cpuData = history.map(h => h.cpu);
    const ramData = history.map(h => h.ram);

    if (historyChart) historyChart.destroy();

    historyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'CPU%',
                    data: cpuData,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                },
                {
                    label: 'RAM%',
                    data: ramData,
                    borderColor: '#8b5cf6',
                    backgroundColor: 'rgba(139, 92, 246, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: true, ticks: { display: false }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { font: { size: 9 }, color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// ─── STATS / MONITOR ─────────────────────────────────────────────────────────
function updateStats(s) {
  if (!s) return;
  qs('#m-cpu').textContent = s.cpu.usage + '%';
  qs('#m-cpu-temp').textContent = s.cpu.temp ? s.cpu.temp + '°C' : 'temp N/A';
  qs('#m-ram').textContent = s.ram.percent + '%';
  qs('#m-ram-detail').textContent = `${s.ram.used} / ${s.ram.total}`;
  qs('#m-net').textContent = `↓ ${s.network.rx}\n↑ ${s.network.tx}`;
  qs('#m-iface').textContent = s.network.iface;
  qs('#m-os').textContent = s.os.distro;
  qs('#m-host').textContent = s.os.hostname;

  if (s.cpu.model) qs('#m-cpu-model').textContent = s.cpu.model;
  if (s.hardware) {
    qs('#m-gpu').textContent = s.hardware.gpu || 'N/A';
    qs('#m-hw-model').textContent = s.hardware.model || '—';
    qs('#m-hw-make').textContent = s.hardware.manufacturer || '—';
  }

  // Notificaciones (Phase 3)
  if ('Notification' in window && Notification.permission === 'granted') {
     const now = Date.now();
     if (now - lastNotifTime > 60000) { // Max 1 notif per minute
         if (s.cpu.usage > 90) {
             new Notification('⚠️ moshiClaw: Alerta de Sistema', { body: `La CPU está al ${s.cpu.usage}%` });
             lastNotifTime = now;
         } else if (s.ram.percent > 90) {
             new Notification('⚠️ moshiClaw: Alerta de Sistema', { body: `La RAM está al ${s.ram.percent}%` });
             lastNotifTime = now;
         }
     }
  }

  // Actualizar charts
  if (cpuChart) {
    cpuChart.data.labels.push('');
    cpuChart.data.datasets[0].data.push(s.cpu.usage);
    if (cpuChart.data.labels.length > 30) { cpuChart.data.labels.shift(); cpuChart.data.datasets[0].data.shift(); }
    cpuChart.update('none');
  }
  if (ramChart) {
    ramChart.data.labels.push('');
    ramChart.data.datasets[0].data.push(s.ram.percent);
    if (ramChart.data.labels.length > 30) { ramChart.data.labels.shift(); ramChart.data.datasets[0].data.shift(); }
    ramChart.update('none');
  }

  // Discos
  const diskEl = qs('#disk-list');
  diskEl.innerHTML = s.disks.map(d => `
    <div class="disk-item">
      <div class="disk-header">
        <span class="disk-mount">${d.mount}</span>
        <span class="disk-info">${d.used} / ${d.total} · <b>${d.percent}%</b></span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${d.percent<60?'low':d.percent<85?'mid':'high'}" style="width:${d.percent}%"></div>
      </div>
    </div>
  `).join('');
}

// ─── CHARTS ──────────────────────────────────────────────────────────────────
function initCharts() {
  const chartOpts = (color) => ({
    type: 'line',
    data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(0), borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 }
      }
    }
  });
  cpuChart = new Chart(qs('#chart-cpu'), chartOpts('#00d4ff'));
  ramChart = new Chart(qs('#chart-ram'), chartOpts('#7c3aed'));
}

// ─── TERMINAL ─────────────────────────────────────────────────────────────────
let terminals = {};
let activeTermId = null;
let termModifiers = { Ctrl: false, Alt: false };

function newTerminal() {
  const id = 'term_' + Date.now();
  const container = qs('#terminal-container');
  const div = document.createElement('div');
  div.id = 'term-view-' + id;
  div.style.display = 'none';
  div.style.height = '100%';
  div.style.width = '100%';
  container.appendChild(div);

  const x = new Terminal({
    theme: TERM_THEMES[document.documentElement.getAttribute('data-theme')] || TERM_THEMES.dark,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    cursorBlink: true,
    padding: 10
  });
  const fit = new FitAddon.FitAddon();
  x.loadAddon(fit);
  x.open(div);
  
  setTimeout(() => fit.fit(), 100);

  const ws = new WebSocket(`${WS_BASE}/ws/terminal?token=${authToken}`);
  
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'init', cols: x.cols, rows: x.rows }));
  };
  
  ws.onmessage = (e) => x.write(e.data);
  ws.onclose = () => x.write('\r\n\x1b[33m[Conexión perdida]\x1b[0m\r\n');

  x.onData(d => {
    if (ws.readyState === WebSocket.OPEN) {
      let data = d;
      if (termModifiers.Ctrl && d.length === 1) {
        const charCode = d.toUpperCase().charCodeAt(0);
        if (charCode >= 64 && charCode <= 95) data = String.fromCharCode(charCode - 64);
      } else if (termModifiers.Alt && d.length === 1) {
        data = '\x1b' + d;
      }
      ws.send(data);
      
      // Auto-off for modifiers after one key
      if (termModifiers.Ctrl || termModifiers.Alt) {
          termModifiers.Ctrl = false;
          termModifiers.Alt = false;
          document.querySelectorAll('.key-btn').forEach(b => {
              if (['CTRL', 'ALT'].includes(b.textContent)) b.classList.remove('active');
          });
      }
    }
  });

  x.onResize(size => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    }
  });

  // Observation for auto-fit
  const ro = new ResizeObserver(() => {
    if (div.style.display !== 'none') fit.fit();
  });
  ro.observe(container);
  
  terminals[id] = { x, fit, ws, div, ro };

  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.innerHTML = `<i data-lucide="terminal" style="width:12px; margin-right:4px;"></i> T${Object.keys(terminals).length} <span class="close-tab" style="margin-left:8px; opacity:0.5;">✕</span>`;
  tab.onclick = (e) => {
      if (e.target.classList.contains('close-tab')) {
          closeTerminal(id, tab);
          return;
      }
      switchTerminal(id);
  };
  
  qs('#terminal-nav').appendChild(tab);
  if (typeof lucide !== 'undefined') lucide.createIcons();
  
  switchTerminal(id);
}

function closeTerminal(id, tabEl) {
    const t = terminals[id];
    if (!t) return;
    t.ws.close();
    t.ro.disconnect();
    t.div.remove();
    tabEl.remove();
    delete terminals[id];
    const keys = Object.keys(terminals);
    if (keys.length > 0) switchTerminal(keys[keys.length - 1]);
    else activeTermId = null;
}

function switchTerminal(id) {
  activeTermId = id;
  Object.keys(terminals).forEach(k => {
    terminals[k].div.style.display = (k === id) ? 'block' : 'none';
    if (k === id) {
        setTimeout(() => {
            terminals[k].fit.fit();
            terminals[k].x.focus();
        }, 50);
    }
  });
  document.querySelectorAll('.term-tab').forEach((t, i) => {
    t.classList.toggle('active', Object.keys(terminals)[i] === id);
  });
}

function toggleTermKey(btn, key) {
    termModifiers[key] = !termModifiers[key];
    btn.classList.toggle('active', termModifiers[key]);
}

function sendTermKey(key) {
    if (!activeTermId) return;
    const t = terminals[activeTermId];
    let code = '';
    if (key === 'Esc') code = '\x1b';
    else if (key === 'Tab') code = '\t';
    else if (key === 'Up') code = '\x1b[A';
    else if (key === 'Down') code = '\x1b[B';
    else if (key === 'Right') code = '\x1b[C';
    else if (key === 'Left') code = '\x1b[D';
    else code = key;

    if (t.ws.readyState === WebSocket.OPEN) t.ws.send(code);
    t.x.focus();
}

async function copyTerm() {
  if (!activeTermId) return;
  const text = terminals[activeTermId].x.getSelection();
  if (text) await navigator.clipboard.writeText(text);
}

async function pasteTerm() {
  const text = await navigator.clipboard.readText();
  if (activeTermId && text) terminals[activeTermId].ws.send(text);
}

// Inicialización de tabs al abrir panel terminal
let terminalInitialized = false;
function initTerminal() {
  if (terminalInitialized) return;
  terminalInitialized = true;
  newTerminal();
}

// ─── CLAUDE CODE — GESTOR DE AGENTES ─────────────────────────────────────────
const ccAgents     = new Map();   // id → { term, ws, fit, ro, div, chipEl, status, absPath, relPath, label, outputBuf, outputTimer, notifiedFor }
let ccActiveId     = null;
let ccAgentSeq     = 0;
let ccCurrentPath  = '/';         // ruta que se está navegando en el explorador
let ccModifiers    = { Ctrl: false };
let ccBrowserMode  = false;       // true = estamos en modo explorador para añadir agente

// ── Persistencia de agentes ───────────────────────────────────────────────
function ccSaveState() {
  const data = [...ccAgents.values()].map(a => ({
    absPath: a.absPath,
    relPath: a.relPath,
    label:   a.label
  }));
  try { localStorage.setItem('oc_cc_agents', JSON.stringify(data)); } catch {}
}

// ── Punto de entrada al panel ──────────────────────────────────────────────
// ── Punto de entrada al panel ────────────────────────────────────────────
function initClaudeCode() {
  if (ccAgents.size === 0) {
    // Restaurar agentes guardados de sesiones anteriores
    const saved = JSON.parse(localStorage.getItem('oc_cc_agents') || '[]');
    if (saved.length) {
      saved.forEach(a => ccCreateAgent(a.absPath, a.relPath));
      return; // ccCreateAgent ya muestra la vista de terminal
    }
    ccShowBrowser();
    ccLoadDir(ccCurrentPath);
  } else if (ccActiveId) {
    ccShowTerminal();
  } else {
    ccShowBrowserForNew();
  }
}

// ── Cambio de vistas ─────────────────────────────────────────────────────
function ccShowBrowserForNew() {
  ccBrowserMode = true;
  ccShowBrowser();
  ccLoadDir(ccCurrentPath);
}

function ccShowBrowser() {
  qs('#cc-browser-view').style.display = 'flex';
  qs('#cc-terminal-view').style.display = 'none';
}

function ccShowTerminal() {
  qs('#cc-browser-view').style.display = 'none';
  qs('#cc-terminal-view').style.display = 'flex';
  const agent = ccAgents.get(ccActiveId);
  if (agent) setTimeout(() => { agent.fit.fit(); agent.term.focus(); }, 80);
}

// ── Explorador de directorios ────────────────────────────────────────────
async function ccLoadDir(relPath) {
  ccCurrentPath = relPath;

  // Breadcrumb
  const parts = relPath.split('/').filter(Boolean);
  let html = `<span onclick="ccLoadDir('/')">~</span>`;
  let built = '';
  parts.forEach(p => {
    built += '/' + p;
    const cap = built;
    html += ` / <span onclick="ccLoadDir('${cap.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')"> ${p}</span>`;
  });
  const bcEl = qs('#cc-breadcrumb');
  if (bcEl) bcEl.innerHTML = html;
  const bb = qs('#cc-back-btn');
  if (bb) bb.disabled = (relPath === '/');

  const grid = qs('#cc-dir-grid');
  if (!grid) return;
  grid.innerHTML = `<div class="cc-empty"><i data-lucide="loader-2" style="width:22px;height:22px;display:block;margin:0 auto 10px;animation:spin 0.9s linear infinite;"></i>Cargando...</div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res  = await fetch(`/api/files/list?path=${encodeURIComponent(relPath)}`,
                             { headers: { Authorization: `Bearer ${authToken}` } });
    const data = await res.json();
    const dirs = (data.items || []).filter(i => i.isDirectory);

    if (!dirs.length) {
      grid.innerHTML = `<div class="cc-empty"><i data-lucide="folder-x" style="width:28px;height:28px;display:block;margin:0 auto 10px;opacity:0.4;"></i>Sin subcarpetas aquí</div>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }
    grid.innerHTML = dirs.map(d => {
      const sp = d.path.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      return `<div class="cc-dir-card" onclick="ccNavigate('${sp}')">
        <i data-lucide="folder" style="width:30px;height:30px;color:#f59e0b;flex-shrink:0;"></i>
        <div class="cc-dir-name">${d.name}</div>
        <button class="cc-open-dir-btn" title="Abrir Claude Code aquí" onclick="event.stopPropagation();ccOpenInDir('${sp}')">
          <i data-lucide="zap" style="width:11px;height:11px;"></i>
        </button>
      </div>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch {
    grid.innerHTML = `<div class="cc-empty" style="color:var(--red);">Error al cargar directorio</div>`;
  }
}

function ccGoBack() {
  const parts = ccCurrentPath.split('/').filter(Boolean);
  if (!parts.length) return;
  parts.pop();
  ccLoadDir(parts.length ? '/' + parts.join('/') : '/');
}
function ccNavigate(relPath) { ccLoadDir(relPath); }
function ccOpenHere()        { ccOpenInDir(ccCurrentPath); }

function ccOpenInDir(relPath) {
  const absPath = '/home/moshi' + (relPath === '/' ? '' : relPath);
  ccBrowserMode = false;
  ccCreateAgent(absPath, relPath);
}

// ── Gestor de agentes ────────────────────────────────────────────────────
function ccCreateAgent(absPath, relPath) {
  const id    = 'cca_' + (++ccAgentSeq) + '_' + Date.now();
  const label = relPath.split('/').filter(Boolean).pop() || '~';

  // Crear div de terminal
  const div = document.createElement('div');
  div.className = 'cc-term-view';
  div.id = 'cc-term-' + id;
  qs('#cc-terms-container').appendChild(div);

  // xterm
  const x = new Terminal({
    theme: CC_TERM_THEMES[document.documentElement.getAttribute('data-theme')] || CC_TERM_THEMES.dark,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 13, cursorBlink: true, padding: 8
  });
  const fit = new FitAddon.FitAddon();
  x.loadAddon(fit);
  x.open(div);
  setTimeout(() => fit.fit(), 100);

  const agent = {
    id, label, absPath, relPath,
    term: x, fit, div,
    ws: null, ro: null,
    status: 'connecting',
    outputBuf: '', outputTimer: null, notifiedFor: null,
    chipEl: null
  };

  // Keyboard input (referencia a agent.ws para poder reemplazarla en restart)
  x.onData(d => {
    if (!agent.ws || agent.ws.readyState !== WebSocket.OPEN) return;
    let data = d;
    if (ccModifiers.Ctrl && d.length === 1) {
      const cc = d.toUpperCase().charCodeAt(0);
      if (cc >= 64 && cc <= 95) data = String.fromCharCode(cc - 64);
      ccModifiers.Ctrl = false;
      const ctrlBtn = qs('#claude-ctrl-btn');
      if (ctrlBtn) ctrlBtn.classList.remove('active');
    }
    agent.ws.send(data);
  });

  x.onResize(size => {
    if (agent.ws && agent.ws.readyState === WebSocket.OPEN)
      agent.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
  });

  const ro = new ResizeObserver(() => { if (agent.fit) agent.fit.fit(); });
  ro.observe(div);
  agent.ro = ro;

  ccAgents.set(id, agent);
  ccSaveState();       // persistir lista de agentes
  _ccConnect(agent);   // abre WebSocket y lanza Claude Code
  ccSelectAgent(id);
  ccShowTerminal();
  _ccRenderAgentsBar();
}

function _ccConnect(agent) {
  const ws = new WebSocket(`${WS_BASE}/ws/terminal?token=${authToken}`);
  agent.ws = ws;
  agent.status = 'connecting';
  _ccUpdateChip(agent.id);

  ws.onopen = () => {
    agent.status = 'running';
    _ccUpdateChip(agent.id);
    ws.send(JSON.stringify({ type: 'init', cols: agent.term.cols, rows: agent.term.rows }));
    const safeP = agent.absPath.replace(/"/g, '\\"');
    setTimeout(() => ws.send(`cd "${safeP}"\r`), 300);
    setTimeout(() => ws.send(`npx claude --dangerously-skip-permissions\r`), 700);
  };

  ws.onmessage = (e) => {
    agent.term.write(e.data);
    const stripped = _ccStripAnsi(e.data);

    // Si Claude estaba esperando y llega output real → está trabajando de nuevo
    if ((agent.status === 'waiting' || agent.status === 'done') &&
        stripped.replace(/[\s\r\n]/g, '').length > 3) {
      agent.status = 'running';
      agent.notifiedFor = null;
      _ccUpdateChip(agent.id);
    }

    agent.outputBuf = (agent.outputBuf + stripped).slice(-1200);
    clearTimeout(agent.outputTimer);
    agent.outputTimer = setTimeout(() => _ccDetect(agent), 1800);
  };

  ws.onclose = () => {
    agent.status = 'error';
    _ccUpdateChip(agent.id);
    agent.term.write('\r\n\x1b[31m[Sesión cerrada — presiona ↻ para reiniciar]\x1b[0m\r\n');
    if (agent.id === ccActiveId) _setClaudeStatus('desconectado');
  };
}

function ccSelectAgent(id) {
  ccActiveId = id;
  // Mostrar/ocultar terminales
  ccAgents.forEach((a, aid) => {
    a.div.classList.toggle('cc-term-active', aid === id);
  });
  // Actualizar topbar
  const agent = ccAgents.get(id);
  if (agent) {
    const pathEl = qs('#cc-active-path');
    if (pathEl) pathEl.textContent = '~' + (agent.relPath === '/' ? '' : agent.relPath);
    _setClaudeStatus(_ccStatusLabel(agent.status));
    // Resetear notificación al enfocar
    agent.notifiedFor = null;
    setTimeout(() => { agent.fit.fit(); agent.term.focus(); }, 80);
  }
  _ccRenderAgentsBar();
}

function ccCloseAgent(id) {
  const agent = ccAgents.get(id);
  if (!agent) return;
  clearTimeout(agent.outputTimer);
  try { agent.ws.close();     } catch {}
  try { agent.term.dispose(); } catch {}
  try { agent.ro.disconnect(); } catch {}
  agent.div.remove();
  ccAgents.delete(id);
  ccSaveState();       // actualizar lista persistida

  if (ccActiveId === id) {
    const remaining = [...ccAgents.keys()];
    if (remaining.length) {
      ccSelectAgent(remaining[remaining.length - 1]);
      ccShowTerminal();
    } else {
      ccActiveId = null;
      ccShowBrowserForNew();
    }
  }
  _ccRenderAgentsBar();
}

function ccRestartActive() {
  const agent = ccAgents.get(ccActiveId);
  if (!agent) return;
  clearTimeout(agent.outputTimer);
  try { agent.ws.close(); } catch {}
  agent.term.clear();
  agent.outputBuf = '';
  agent.notifiedFor = null;
  _ccConnect(agent);
}

// ── Renderizado de chips ──────────────────────────────────────────────────
function _ccRenderAgentsBar() {
  const bar = qs('#cc-agents-bar');
  if (!bar) return;
  bar.style.display = ccAgents.size ? 'flex' : 'none';

  // Quitar chips viejos (no el botón +)
  bar.querySelectorAll('.cc-agent-chip').forEach(el => el.remove());

  const addBtn = qs('#cc-add-agent-btn');
  ccAgents.forEach((agent, id) => {
    const chip = document.createElement('div');
    chip.className = `cc-agent-chip s-${agent.status}${id === ccActiveId ? ' cc-active' : ''}`;
    chip.id = 'cc-chip-' + id;
    chip.innerHTML = `
      <span class="cc-agent-dot"></span>
      <span class="cc-chip-label">${agent.label}</span>
      <button class="cc-chip-close" onclick="event.stopPropagation();ccCloseAgent('${id}')" title="Cerrar agente">✕</button>`;
    chip.addEventListener('click', () => {
      ccSelectAgent(id);
      ccShowTerminal();
    });
    agent.chipEl = chip;
    bar.insertBefore(chip, addBtn);
  });
}

function _ccUpdateChip(id) {
  const agent = ccAgents.get(id);
  if (!agent || !agent.chipEl) { _ccRenderAgentsBar(); return; }
  agent.chipEl.className = `cc-agent-chip s-${agent.status}${id === ccActiveId ? ' cc-active' : ''}`;
  if (id === ccActiveId) _setClaudeStatus(_ccStatusLabel(agent.status));
}

function _ccStatusLabel(s) {
  return { connecting:'conectando...', running:'activo', waiting:'esperando', done:'listo', error:'error' }[s] || s;
}

// ── Detección de estado por output ───────────────────────────────────────
function _ccStripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][012AB]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function _ccDetect(agent) {
  // Solo actuar si Claude está trabajando (running)
  if (agent.status !== 'running') return;

  const tail = agent.outputBuf.slice(-700);

  // Detectar prompt ❯ de Claude Code (indica que terminó y espera input)
  const atPrompt =
    /[❯›][\s\r\n]{0,8}$/.test(tail);

  // Detectar si necesita confirmación del usuario
  const needsConfirm =
    /\(y\/n\)/i.test(tail) ||
    /\[yes\/no\]/i.test(tail) ||
    /Do you want/i.test(tail.slice(-400)) ||
    /Allow this/i.test(tail.slice(-400)) ||
    /proceed\?/i.test(tail.slice(-300)) ||
    /Are you sure/i.test(tail.slice(-300));

  if (!atPrompt && !needsConfirm) return;

  // Transicionar a waiting
  agent.status = 'waiting';
  _ccUpdateChip(agent.id);

  // Notificar a menos que el usuario esté mirando exactamente este agente
  const isWatching =
    !document.hidden &&
    agent.id === ccActiveId &&
    !!document.querySelector('#panel-claudecode.active');

  if (!isWatching && agent.notifiedFor !== 'waiting') {
    agent.notifiedFor = 'waiting';
    const title = needsConfirm
      ? '⚠️ Agente necesita tu confirmación'
      : '✅ Agente completó la tarea';
    const body = needsConfirm
      ? `${agent.label} está esperando una respuesta`
      : `${agent.label} terminó y espera tu próxima instrucción`;
    ccNotify(title, body, agent.id);
  }
  // El buffer NO se limpia — ventana deslizante de 1200 chars
}

// ── Notificaciones PWA ────────────────────────────────────────────────────
async function ccNotify(title, body, agentId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      icon:      '/icons/icon-192.png',
      badge:     '/icons/icon-192.png',
      tag:       'cc-' + agentId,   // reemplaza notif anterior del mismo agente
      renotify:  true,
      data:      { agentId }
    });
  } catch {
    // Fallback si el SW no soporta showNotification
    try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch {}
  }
}

// ── Teclado móvil ────────────────────────────────────────────────────────
function toggleClaudeKey(btn, key) {
  ccModifiers[key] = !ccModifiers[key];
  btn.classList.toggle('active', ccModifiers[key]);
}

function sendClaudeKey(key) {
  const agent = ccAgents.get(ccActiveId);
  if (!agent || !agent.ws || agent.ws.readyState !== WebSocket.OPEN) return;
  const map = { Esc:'\x1b', Tab:'\t', Up:'\x1b[A', Down:'\x1b[B', Right:'\x1b[C', Left:'\x1b[D' };
  agent.ws.send(map[key] || key);
  agent.term.focus();
}

async function copyClaudeTerm() {
  const agent = ccAgents.get(ccActiveId);
  if (!agent) return;
  const text = agent.term.getSelection();
  if (text) await navigator.clipboard.writeText(text);
}

async function pasteClaudeTerm() {
  const agent = ccAgents.get(ccActiveId);
  if (!agent || !agent.ws || agent.ws.readyState !== WebSocket.OPEN) return;
  const text = await navigator.clipboard.readText();
  if (text) agent.ws.send(text);
}

// ── Helpers compartidos ──────────────────────────────────────────────────
function _setClaudeStatus(txt) {
  const el = qs('#claudecode-status');
  if (!el) return;
  el.textContent = txt;
  const colors = { activo:'var(--green)', listo:'var(--green)', esperando:'var(--orange)', error:'var(--red)', desconectado:'var(--red)' };
  el.style.color = colors[txt] || 'var(--text3)';
}

// ── Setting on/off ────────────────────────────────────────────────────────
function applyClaudeCodeSetting() {
  const tab = qs('#tab-claudecode');
  if (!tab) return;
  const enabled = !!settings.claudeCode;
  tab.style.display = enabled ? '' : 'none';
  if (!enabled && document.querySelector('#panel-claudecode.active')) {
    switchPanel('chat');
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── SCREEN SHARE (getDisplayMedia) ──────────────────────────────────────────
// ─── SCREEN STREAM ────────────────────────────────────────────────────────────
function initScreen() {
  if (screenActive) return;
  screenActive = true;
  connectScreen();
}

function pauseScreen() {
  screenActive = false;
  if (screenWS) { screenWS.close(); screenWS = null; }
  window.removeEventListener('keydown', handleScreenKeydown);
}

function connectScreen() {
  if (!screenActive) return;
  if (screenWS) screenWS.close();

  // Escuchar inputs en ventana completa (si panel está activo)
  window.addEventListener('keydown', handleScreenKeydown);

  screenWS = new WebSocket(`${WS_BASE}/ws/screen?token=${authToken}`);
  const canvas = qs('#screen-canvas');
  const ctx = canvas.getContext('2d');
  const placeholder = qs('#screen-placeholder');

  screenWS.onopen = () => {
    show(canvas); hide(placeholder);
    screenFpsCounter = 0; lastFpsTime = Date.now();
  };

  screenWS.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        qs('#screen-res').textContent = `${img.width}×${img.height}`;
      };
      img.src = 'data:image/jpeg;base64,' + msg.data;

      screenFpsCounter++;
      const now = Date.now();
      if (now - lastFpsTime >= 1000) {
        qs('#screen-fps').textContent = screenFpsCounter + ' fps';
        screenFpsCounter = 0; lastFpsTime = now;
      }
    } else if (msg.type === 'error') {
      hide(canvas); show(placeholder);
      const isLock = msg.message.includes('bloqueó') || msg.message.includes('🔒');
      placeholder.querySelector('.ph-icon').textContent = isLock ? '🔒' : '❌';
      placeholder.querySelector('p').textContent = msg.message;
    } else if (msg.type === 'info') {
      placeholder.querySelector('.ph-icon').textContent = '🖥️';
      placeholder.querySelector('p').textContent = msg.message;
    }
  };

  screenWS.onclose = () => {
    hide(canvas); show(placeholder);
    placeholder.querySelector('.ph-icon').textContent = '🖥️';
    placeholder.querySelector('p').textContent = 'Reconectando...';
    if (screenActive) setTimeout(connectScreen, 3000);
  };

  setupCanvasInput(canvas);
}

// ─── Control Remoto ──────────

function setupCanvasInput(canvas) {
  // Evitar que se asocien múltiples listeners
  if (canvas._hasInputSetup) return;
  canvas._hasInputSetup = true;

  // Calculador de offset a tamaño real de pantalla
  const getCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  };

  let dragging = false;

  canvas.addEventListener('mousedown', e => {
    if (!screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    dragging = true;
    const { x, y } = getCoords(e);
    // Mousemove previo al click para ubicarnos, y luego click
    screenWS.send(JSON.stringify({ type: 'mousemove', x, y }));
    screenWS.send(JSON.stringify({ type: 'mousedown', button: processButton(e.button) }));
  });

  canvas.addEventListener('mousemove', e => {
    if (!dragging || !screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    const { x, y } = getCoords(e);
    screenWS.send(JSON.stringify({ type: 'mousemove', x, y }));
  });

  canvas.addEventListener('mouseup', e => {
    if (!screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    dragging = false;
    const { x, y } = getCoords(e);
    screenWS.send(JSON.stringify({ type: 'mousemove', x, y }));
    screenWS.send(JSON.stringify({ type: 'mouseup', button: processButton(e.button) }));
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // Soporte básico para Touch (Mobile)
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    dragging = true;
    const touch = e.touches[0];
    const { x, y } = getCoords(touch);
    screenWS.send(JSON.stringify({ type: 'mousemove', x, y }));
    screenWS.send(JSON.stringify({ type: 'mousedown', button: 1 }));
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!dragging || !screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    const touch = e.touches[0];
    const { x, y } = getCoords(touch);
    screenWS.send(JSON.stringify({ type: 'mousemove', x, y }));
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    if (!screenWS || screenWS.readyState !== WebSocket.OPEN) return;
    dragging = false;
    screenWS.send(JSON.stringify({ type: 'mouseup', button: 1 }));
  }, { passive: false });
}

function processButton(b) {
  if (b === 0) return 1; // Left
  if (b === 1) return 2; // Middle
  if (b === 2) return 3; // Right
  return 1;
}

function handleScreenKeydown(e) {
  if (!screenActive || !screenWS || screenWS.readyState !== WebSocket.OPEN) return;
  // No capturar teclas si estás escribiendo en input (ej: navegador URL)
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

  e.preventDefault();
  screenWS.send(JSON.stringify({ type: 'keydown', key: e.key }));
}

// ─── BROWSER ──────────────────────────────────────────────────────────────────
function navBrowser() {
    let url = qs('#browser-url').value;
    if (!url.startsWith('http')) url = 'https://' + url;
    eventsWS.send(JSON.stringify({ type: 'browser', action: 'navigate', url }));
}

function browserRefresh() {
    const url = qs('#browser-url').value;
    if (url) navBrowser();
    else eventsWS && eventsWS.send(JSON.stringify({ type: 'browser', action: 'screenshot' }));
}

function browserScroll(dir) {
    // Scroll usando evaluate en el navegador headless
    eventsWS && eventsWS.send(JSON.stringify({
        type: 'browser', action: 'scroll', direction: dir
    }));
}

function browserManualScreenshot() {
    eventsWS && eventsWS.send(JSON.stringify({ type: 'browser', action: 'screenshot' }));
}

function updateBrowserScreenshot(imgB64) {
    const img = qs('#browser-img');
    if (img) img.src = 'data:image/jpeg;base64,' + imgB64;
    const placeholder = qs('#browser-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    if (img) img.style.display = 'block';
}

// ─── WEBCAM ───────────────────────────────────────────────────────────────────
let webcamActive = false;
function initWebcam() { webcamActive = true; }
function pauseWebcam() { webcamActive = false; }
async function takeWebcamSnap() {
    qs('#webcam-msg').style.display = 'block';
    qs('#webcam-msg').textContent = 'Capturando...';
    qs('#webcam-img').style.display = 'none';

    try {
        const res = await fetch(`/api/webcam-snap?token=${authToken}`);
        const data = await res.json();
        if (data.image) {
            qs('#webcam-img').src = 'data:image/jpeg;base64,' + data.image;
            qs('#webcam-img').style.display = 'block';
            qs('#webcam-msg').style.display = 'none';
        } else {
            qs('#webcam-msg').textContent = data.error || 'Error al capturar webcam';
        }
    } catch(err) {
        qs('#webcam-msg').textContent = 'Error de conexión';
    }
}

// ─── FILES MANAGER ────────────────────────────────────────────────────────────
let fmInitialized = false;

async function fmLoad() {
    const path = qs('#fm-path').value || '/';
    try {
        const res = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`, {
            headers: { 'Authorization': 'Bearer ' + authToken }
        });
        const data = await res.json();
        if (data.success) {
            renderFileList(data.items);
            qs('#fm-path').value = path.endsWith('/') && path.length > 1 ? path.slice(0,-1) : path;
        } else {
            alert('Error cargando directorio: ' + data.error);
        }
    } catch (err) {
        alert('Error conectando con el servidor para archivos.');
    }
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function renderFileList(items) {
    const list = qs('#fm-list');
    list.innerHTML = '';
    
    if (items.length === 0) {
        list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px;">Carpeta vacía</div>';
        return;
    }

    items.forEach(item => {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.background = 'var(--surface)';
        el.style.padding = '10px 14px';
        el.style.borderRadius = '8px';
        el.style.border = '1px solid var(--border)';
        el.style.gap = '10px';
        
        const iconName = item.isDirectory ? 'folder' : 'file';
        const color = item.isDirectory ? 'var(--accent)' : 'var(--text2)';
        const ext = item.name.split('.').pop().toLowerCase();
        const isMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg'].includes(ext);
        
        el.innerHTML = `
            <div style="font-size: 20px;"><i data-lucide="${iconName}" style="color:${color}"></i></div>
            <div style="flex:1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; color: ${color}; cursor: pointer;" onclick="fmItemClick('${item.path}', ${item.isDirectory})">${item.name}</div>
            <div style="font-size: 11px; color: var(--text3); width: 60px; text-align: right;">${item.isDirectory ? '' : formatBytes(item.size)}</div>
            <div style="display:flex; gap: 4px;">
                ${isMedia ? `<button class="icon-btn" style="width:30px;height:30px;font-size:12px;color:var(--accent);" onclick="showPreview('${item.path}', '${ext}')" title="Previsualizar"><i data-lucide="eye"></i></button>` : ''}
                ${!item.isDirectory ? `<button class="icon-btn" style="width:30px;height:30px;font-size:12px" onclick="fmDownload('${item.path}')" title="Descargar"><i data-lucide="download"></i></button>` : ''}
                <button class="icon-btn" style="width:30px;height:30px;font-size:12px" onclick="fmRename('${item.path}', '${item.name}')" title="Renombrar"><i data-lucide="edit-3"></i></button>
                <button class="icon-btn" style="width:30px;height:30px;font-size:12px;color:var(--red);" onclick="fmDelete('${item.path}')" title="Borrar"><i data-lucide="trash-2"></i></button>
            </div>
        `;
        list.appendChild(el);
    });
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fmItemClick(path, isDir) {
    if (isDir) {
        qs('#fm-path').value = path;
        fmLoad();
    } else {
        const ext = path.split('.').pop().toLowerCase();
        const media = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg'];
        if (media.includes(ext)) {
            showPreview(path, ext);
        }
    }
}

function showPreview(path, ext) {
    const modal = qs('#preview-modal');
    const body = qs('#preview-body');
    const filename = qs('#preview-filename');
    
    filename.textContent = path.split('/').pop();
    body.innerHTML = '<div style="color:var(--text3)">Cargando vista previa...</div>';
    modal.classList.add('open');
    
    const url = `/api/files/preview?path=${encodeURIComponent(path)}&token=${authToken}`;
    
    if (['mp4', 'webm', 'ogg'].includes(ext)) {
        body.innerHTML = `<video src="${url}" controls autoplay style="max-width:100%; max-height:70vh;"></video>`;
    } else {
        const img = new Image();
        img.onload = () => { body.innerHTML = ''; body.appendChild(img); };
        img.onerror = () => { body.innerHTML = '<div style="color:var(--red)">No se pudo cargar la imagen</div>'; };
        img.src = url;
    }
}

function closePreview() {
    qs('#preview-modal').classList.remove('open');
    qs('#preview-body').innerHTML = '';
}

function fmGoUp() {
    let p = qs('#fm-path').value;
    if (p === '/' || p === '') return;
    let parts = p.split('/').filter(Boolean);
    parts.pop();
    qs('#fm-path').value = '/' + parts.join('/');
    fmLoad();
}

function fmDownload(path) {
    const a = document.createElement('a');
    a.href = `/api/files/download?path=${encodeURIComponent(path)}&token=${authToken}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function fmDelete(path) {
    if (!confirm('¿Seguro que quieres borrar: ' + path + '?')) return;
    try {
        const res = await fetch('/api/files/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (data.success) fmLoad();
        else alert('Error: ' + data.error);
    } catch(err) { alert('Request error'); }
}

async function fmRename(oldPath, oldName) {
    const newName = prompt('Nuevo nombre:', oldName);
    if (!newName || newName === oldName) return;
    try {
        const res = await fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ path: oldPath, newName })
        });
        const data = await res.json();
        if (data.success) fmLoad();
        else alert('Error: ' + data.error);
    } catch(err) { alert('Request error'); }
}

async function fmUpload(e) {
    const files = e.target.files;
    if (!files.length) return;
    const path = qs('#fm-path').value || '/';
    
    const formData = new FormData();
    formData.append('path', path);
    for(let i=0; i<files.length; i++) {
        formData.append('files', files[i]);
    }

    try {
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + authToken },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            fmLoad();
        } else alert('Error: ' + data.error);
    } catch (err) {
        alert('Upload failed');
    }
    e.target.value = ''; // clear
}


let pendingThinkingEl = null;
let pendingToolCards = {};     // confirmId → { el, toolName, args }
let pendingToolData = {};      // confirmId → { toolName, args } para confirmación segura
let sessionAutoExec = false;   // Permiso temporal para esta sesión

function addMessage(content, role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'assistant') {
    el.innerHTML = renderMarkdown(content);
  } else {
    el.textContent = content;
  }
  qs('#chat-messages').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
  // Persistir mensajes de usuario y asistente (no mensajes de sistema transitorio)
  if (role === 'user' || role === 'assistant') {
    chatHistory.push({ role, content });
    try { localStorage.setItem('oc_chat', JSON.stringify(chatHistory)); } catch {}
  }
  return el;
}

function showThinking() {
  removeThinking();
  const el = document.createElement('div');
  el.className = 'msg thinking';
  el.innerHTML = `moshiClaw está pensando <span class="thinking-dots"><span style="--i:0">.</span><span style="--i:1">.</span><span style="--i:2">.</span></span>`;
  qs('#chat-messages').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
  pendingThinkingEl = el;
  
  // Transform send button to stop button
  const btn = qs('#btn-send-chat');
  btn.style.background = 'var(--red)';
  btn.innerHTML = '<i data-lucide="square" style="width:18px; height:18px;"></i>';
  btn.title = 'Detener respuesta';
  btn.disabled = false;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function removeThinking() {
  if (pendingThinkingEl) { pendingThinkingEl.remove(); pendingThinkingEl = null; }
  
  // Reset send button
  const btn = qs('#btn-send-chat');
  btn.style.background = 'var(--accent)';
  btn.innerHTML = '➤';
  btn.title = 'Enviar mensaje';
}

function toggleThinking(btn) {
  btn.classList.toggle('open');
  btn.nextElementSibling.classList.toggle('open');
}

function showResponse(text, provider, thinking) {
  removeThinking();
  if (thinking) {
    const words = thinking.trim().split(/\s+/).length;
    const thinkEl = document.createElement('div');
    thinkEl.className = 'thinking-block';
    thinkEl.innerHTML = `
      <div class="thinking-toggle" onclick="toggleThinking(this)">
        <span class="t-arrow">▶</span>
        <span>💭 Pensamiento interno</span>
        <span style="margin-left:auto;opacity:0.45;font-size:11px">${words} palabras</span>
      </div>
      <div class="thinking-body">${renderMarkdown(thinking)}</div>`;
    qs('#chat-messages').appendChild(thinkEl);
    thinkEl.scrollIntoView({ behavior: 'smooth' });
  }
  const el = addMessage(text, 'assistant');
  qs('#btn-send-chat').disabled = false;
  if (lastQueryWasVoice || jarvisMode) jarvisNotify(text);
  speakResponse(text);
}

function showChatError(err) {
  removeThinking();
  addMessage(`⚠️ ${err}`, 'system');
  qs('#btn-send-chat').disabled = false;
}

// Mapa para vincular tarjetas de herramientas con sus resultados por toolId único
const _toolCardMap = new Map();

function handleToolEvent(event) {
  // 'toolType' es el tipo real del evento (server.js lo separa para no pisar msg.type='chat_tool')
  const evtType = event.toolType || event.type;

  if (evtType === 'step') {
    // Mensajes de progreso del agente (step_update tool)
    const stepEl = document.createElement('div');
    stepEl.className = 'msg step-update';
    stepEl.textContent = event.message;
    qs('#chat-messages').appendChild(stepEl);
    stepEl.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (evtType === 'executing') {
    // step_update se muestra solo como mensaje de progreso (evento 'step'), no como tarjeta
    if (event.name === 'step_update') return;
    const toolId = event.toolId || `tc_${Date.now()}_${Math.random()}`;
    // Formatear args según el tipo de herramienta
    let cmdDisplay = '';
    if (event.name === 'write_file') {
      const lines = (event.args && event.args.content || '').split('\n').length;
      cmdDisplay = `📄 ${escapeHtml(event.args.path || '')} (${lines} líneas)`;
    } else if (event.name === 'step_update') {
      cmdDisplay = escapeHtml(event.args && event.args.message || '');
    } else if (event.args && event.args.command) {
      cmdDisplay = `${escapeHtml(event.args.command)}`;
    } else {
      cmdDisplay = escapeHtml(JSON.stringify(event.args || {}));
    }
    
    let ocVerb = event.name;
    if (ocVerb === 'execute_command') ocVerb = 'exec';
    else if (ocVerb === 'read_file') ocVerb = 'read';
    else if (ocVerb === 'write_file') ocVerb = 'write';
    else if (ocVerb === 'browser_navigate') ocVerb = 'nav';
    else if (ocVerb === 'generate_image') ocVerb = 'image';

    const card = document.createElement('div');
    card.className = 'tool-card-oc closed';
    card.dataset.toolId = toolId;
    card.innerHTML = `
      <div class="oc-header" onclick="this.parentElement.classList.toggle('closed')">
        <span class="oc-arrow">▼</span>
        <span class="oc-icon">⚡</span>
        <span class="oc-title"><b>1 tool</b> ${escapeHtml(ocVerb)}</span>
      </div>
      <div class="oc-body">
        <div class="oc-tool-name" style="margin-bottom: 8px;">
           <i data-lucide="file-code-2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> 
           <span style="font-weight:bold; color:var(--text1)">${escapeHtml(event.name.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase()))}</span>
        </div>
        <div class="oc-cmd" style="font-family:monospace; color:var(--text2); margin-bottom: 12px;">with ${cmdDisplay}</div>
        <div class="oc-result running" style="color:var(--text3); font-size:12px;">⏳ Ejecutando...</div>
      </div>
    `;
    qs('#chat-messages').appendChild(card);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    card.scrollIntoView({ behavior: 'smooth' });
    _toolCardMap.set(toolId, card);
  } else if (evtType === 'result') {
    if (event.name === 'step_update') return; // ya manejado por el evento 'step'
    const toolId = event.toolId;
    const card = toolId ? _toolCardMap.get(toolId) : null;
    if (card) {
      const resultEl = card.querySelector('.oc-result');
      if (resultEl) {
        resultEl.classList.remove('running');
        const resultText = String(event.result || '');
        const isError = /\berror\b/i.test(resultText) && !resultText.startsWith('✅');
        
        resultEl.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; color: var(--text3); font-size: 11px;">
             <span>${isError ? 'Failed' : 'Completed'}</span>
             <span>${isError ? '<i data-lucide="x" style="color:var(--red);width:14px;height:14px;"></i>' : '<i data-lucide="check" style="color:var(--green);width:14px;height:14px;"></i>'}</span>
          </div>
          <div class="oc-output-log" style="display:none; margin-top:8px; white-space:pre-wrap; font-family:monospace; font-size:11px; color:var(--text2); background:var(--bg); border: 1px solid var(--border); padding:8px; border-radius:4px;"></div>
        `;
        const logEl = resultEl.querySelector('.oc-output-log');
        logEl.textContent = resultText;
        if(isError || resultText.length < 300) {
            logEl.style.display = 'block';
        } else {
            const btn = document.createElement('button');
            btn.textContent = 'Ver output completo';
            btn.style.cssText = 'background:none; border:none; color:var(--accent); cursor:pointer; font-size:11px; margin-top:4px; padding:0;';
            btn.onclick = () => { logEl.style.display = logEl.style.display==='none' ? 'block' : 'none'; };
            resultEl.appendChild(btn);
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
      _toolCardMap.delete(toolId);
    }
  } else if (evtType === 'needs_confirmation') {
    // Si ya aceptamos todo esta sesión, confirmamos automáticamente
    if (sessionAutoExec) {
        confirmTool(event.confirmId);
        return;
    }

    // Guardar args de forma segura en memoria, no en HTML
    pendingToolData[event.confirmId] = { toolName: event.name, args: event.args };

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.confirmId = event.confirmId;
    card.innerHTML = `
      <div class="tool-header">🤖 moshiClaw quiere ejecutar:</div>
      <div class="tool-cmd">$ ${escapeHtml(event.args.command || JSON.stringify(event.args))}</div>
      <div class="tool-actions">
        <button class="btn-confirm btn-confirm-action" title="Aceptar esta vez">✓ Aceptar</button>
        <button class="btn-confirm btn-confirm-all" style="background:var(--accent2); color:white" title="Aceptar todos los comandos de esta sesión">✓ Aceptar Todo</button>
        <button class="btn-cancel-tool btn-cancel-action" title="Denegar">✕ Negar</button>
      </div>
      <div class="tool-result" style="display:none"></div>
    `;
    card.querySelector('.btn-confirm-action').addEventListener('click', () => {
      confirmTool(event.confirmId);
    });
    card.querySelector('.btn-confirm-all').addEventListener('click', () => {
      if (confirm('¿Seguro que querés permitir todos los comandos de esta sesión sin preguntar?')) {
          sessionAutoExec = true;
          confirmTool(event.confirmId);
      }
    });
    card.querySelector('.btn-cancel-action').addEventListener('click', () => {
      cancelTool(event.confirmId);
    });
    qs('#chat-messages').appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
    pendingToolCards[event.confirmId] = card;
    // Registrar en _toolCardMap para que el resultado actualice la tarjeta
    if (event.toolId) _toolCardMap.set(event.toolId, card);
  }
}

function confirmTool(confirmId) {
  const data = pendingToolData[confirmId];
  if (!data) return;
  if (eventsWS && eventsWS.readyState === WebSocket.OPEN) {
    eventsWS.send(JSON.stringify({ type: 'confirm_tool', confirmId, toolName: data.toolName, args: data.args }));
    if (pendingToolCards[confirmId]) {
      const actionsEl = pendingToolCards[confirmId].querySelector('.tool-actions');
      if (actionsEl) actionsEl.innerHTML = '<span style="color:var(--green);font-size:12px">✓ Aceptado</span>';
      const resultEl = pendingToolCards[confirmId].querySelector('.tool-result');
      if (resultEl) { resultEl.style.display = ''; resultEl.classList.add('running'); resultEl.textContent = '⏳ Ejecutando...'; }
    }
    delete pendingToolData[confirmId];
  }
}

function cancelTool(confirmId) {
  if (eventsWS && eventsWS.readyState === WebSocket.OPEN) {
    eventsWS.send(JSON.stringify({ type: 'cancel_tool', confirmId }));
    if (pendingToolCards[confirmId]) {
      pendingToolCards[confirmId].querySelector('.tool-actions').innerHTML = '<span style="color:var(--red);font-size:12px">✕ Cancelado</span>';
    }
    delete pendingToolData[confirmId];
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sendChatMessage() {
  const input = qs('#chat-input');
  
  // If we are thinking, the button acts as STOP
  if (pendingThinkingEl) {
    stopChatResponse();
    return;
  }

  const msg = input.value.trim();
  if (!msg) return;

  if (!settings.apiKey && settings.provider !== 'ollama') {
    addMessage('Configurá tu API key en ⚙️ primero.', 'system');
    return;
  }

  addMessage(msg, 'user');
  input.value = '';
  input.style.height = 'auto';
  // Note: We don't disable it here because it will be transformed/handled by showThinking

  if (eventsWS && eventsWS.readyState === WebSocket.OPEN) {
    eventsWS.send(JSON.stringify({
      type: 'chat',
      message: msg,
      provider: settings.provider || 'gemini',
      model: settings.model,
      apiKey: settings.apiKey,
      sessionId: chatSessionId,
      autoExecute: autoExec || sessionAutoExec,
      activeSkillId: activeSkillId || null
    }));
  } else {
    addMessage('Sin conexión al servidor.', 'system');
    qs('#btn-send-chat').disabled = false;
  }
}

// ─── SKILLS ───────────────────────────────────────────────────────────────────

async function loadSkills() {
  try {
    const r = await fetch('/api/skills', { headers: { Authorization: 'Bearer ' + authToken } });
    const data = await r.json();
    _cachedSkills = data.skills || [];
    renderSkillsList();
  } catch (e) { console.error('Error cargando skills:', e); }
}

function renderSkillsList() {
  const list = qs('#skills-list');
  if (!list) return;
  if (_cachedSkills.length === 0) {
    list.innerHTML = '<div class="skills-empty">✨ No hay skills todavía.<br>Creá el primero con el botón de abajo.</div>';
    return;
  }
  list.innerHTML = _cachedSkills.map(sk => {
    const isActive = sk.id === activeSkillId;
    const tags = (sk.tags||[]).map(t => `<span class="skill-tag">${t}</span>`).join('');
    const tagsHtml = tags ? `<div class="skill-tags">${tags}</div>` : '';
    const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return `<div class="skill-card ${isActive?'active':''}">
      <div class="skill-icon">${sk.icon||'🧠'}</div>
      <div class="skill-info">
        <div class="skill-name">${sk.name}</div>
        ${sk.description?`<div class="skill-desc">${sk.description}</div>`:''}
        ${tagsHtml}
      </div>
      <div class="skill-actions">
        <button class="skill-activate-btn" onclick="toggleSkill('${esc(sk.id)}','${esc(sk.name)}','${esc(sk.icon||'🧠')}')">
          ${isActive ? '✓ Activo' : 'Activar'}
        </button>
        <button class="skill-del-btn" onclick="confirmDeleteSkill('${esc(sk.id)}','${esc(sk.name)}',event)" title="Eliminar">✕</button>
      </div>
    </div>`;
  }).join('');
}

function openSkillsPanel() {
  qs('#skills-modal').classList.add('open');
  loadSkills();
}
function closeSkillsPanel() { qs('#skills-modal').classList.remove('open'); }

function toggleSkill(id, name, icon) {
  if (activeSkillId === id) deactivateSkill(); else activateSkill(id, name, icon);
}

function activateSkill(id, name, icon) {
  activeSkillId   = id;
  activeSkillMeta = { id, name, icon };
  localStorage.setItem('oc_active_skill', id);
  localStorage.setItem('oc_active_skill_meta', JSON.stringify(activeSkillMeta));
  updateSkillBadge();
  renderSkillsList();
  closeSkillsPanel();
}

function deactivateSkill() {
  activeSkillId = null; activeSkillMeta = null;
  localStorage.removeItem('oc_active_skill');
  localStorage.removeItem('oc_active_skill_meta');
  updateSkillBadge();
  renderSkillsList();
}

function updateSkillBadge() {
  const badge = qs('#active-skill-badge');
  if (!badge) return;
  if (activeSkillMeta) {
    qs('#active-skill-badge-icon').textContent = activeSkillMeta.icon || '🧠';
    qs('#active-skill-badge-name').textContent = 'Skill: ' + activeSkillMeta.name;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

function openCreateSkillModal() {
  qs('#create-skill-modal').classList.add('open');
  setTimeout(() => qs('#new-skill-name') && qs('#new-skill-name').focus(), 120);
}
function closeCreateSkillModal() { qs('#create-skill-modal').classList.remove('open'); }

async function saveNewSkill() {
  const name    = qs('#new-skill-name').value.trim();
  const icon    = qs('#new-skill-icon').value.trim() || '🧠';
  const desc    = qs('#new-skill-desc').value.trim();
  const tags    = qs('#new-skill-tags').value.trim();
  const content = qs('#new-skill-content').value.trim();
  if (!name) { qs('#new-skill-name').focus(); return; }
  if (!content) { qs('#new-skill-content').focus(); return; }
  try {
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
      body: JSON.stringify({ name, icon, description: desc, tags, content })
    });
    const data = await r.json();
    if (data.success) {
      ['#new-skill-name','#new-skill-desc','#new-skill-tags','#new-skill-content'].forEach(s => { if(qs(s)) qs(s).value=''; });
      if (qs('#new-skill-icon')) qs('#new-skill-icon').value = '🧠';
      closeCreateSkillModal();
      loadSkills();
    } else { alert('Error al guardar: ' + (data.error||'desconocido')); }
  } catch(e) { alert('Error de red: ' + e.message); }
}

async function confirmDeleteSkill(id, name, event) {
  event.stopPropagation();
  if (!confirm('¿Eliminar el skill "' + name + '"?')) return;
  try {
    await fetch('/api/skills/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + authToken }
    });
    if (activeSkillId === id) deactivateSkill();
    loadSkills();
  } catch(e) { alert('Error: ' + e.message); }
}

async function installSkillFromGitHub() {
  const input = qs('#github-skill-url');
  const url = (input ? input.value : '').trim();
  if (!url) {
    alert('Ingresá la URL del repositorio de GitHub');
    return;
  }
  const btn = qs('#btn-install-github');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Instalando...'; }
  try {
    const res = await fetch('/api/skills/install-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
      body: JSON.stringify({ repoUrl: url }),
    });
    // Verificar que la respuesta sea JSON antes de parsear
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (res.status === 404) {
        alert('❌ Ruta no encontrada (404).\n\nReiniciá el servidor de MoshiClaw para cargar la nueva ruta.');
      } else if (res.status === 401 || res.status === 403) {
        alert('❌ Sin autorización. Recargá la página y volvé a iniciar sesión.');
      } else {
        alert(`❌ Respuesta inesperada del servidor (HTTP ${res.status}).\n\nReiniciá el servidor.`);
      }
      return;
    }
    const data = await res.json();
    if (data.success) {
      const names = (data.installed || []).map(s => `${s.icon} ${s.name}`).join(', ');
      const skippedMsg = data.skipped && data.skipped.length ? `\n⚠️ Omitidos: ${data.skipped.length}` : '';
      alert(`✅ ${data.installed.length} skill(s) instalado(s):\n${names}${skippedMsg}`);
      if (input) input.value = '';
      loadSkills();
    } else {
      alert('Error: ' + (data.error || 'No se pudo instalar'));
    }
  } catch (e) {
    alert('Error: ' + e.message + '\n\nSi el servidor no fue reiniciado aún, hacelo ahora para cargar la nueva ruta /api/skills/install-github.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📦 Instalar'; }
  }
}

// ─── FIN SKILLS ───────────────────────────────────────────────────────────────


function clearChatHistory() {
  if (!confirm('¿Seguro que querés limpiar el historial de este chat?')) return;
  if (eventsWS && eventsWS.readyState === WebSocket.OPEN) {
    eventsWS.send(JSON.stringify({ type: 'clear_chat', sessionId: chatSessionId }));
  }
  // Limpiar estado persistente
  chatHistory = [];
  localStorage.removeItem('oc_chat');
  const oldSessionId = chatSessionId;
  chatSessionId = 'session_' + Date.now();
  localStorage.setItem('oc_session_id', chatSessionId);
  qs('#chat-messages').innerHTML = '<div class="msg system">Historial limpiado.</div>';
  sessionAutoExec = false; // Reset session permissions too
  
  // Detener visualmente
  removeThinking();
  qs('#btn-send-chat').disabled = false;
}

function stopChatResponse() {
  if (eventsWS && eventsWS.readyState === WebSocket.OPEN) {
    eventsWS.send(JSON.stringify({ type: 'stop_chat', sessionId: chatSessionId }));
  }
  removeThinking();
  addMessage('Respuesta detenida por el usuario.', 'system');
  qs('#btn-send-chat').disabled = false;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function updateApiKeyHint() {
  const prov = qs('#cfg-provider').value;
  const apikeyInput = qs('#cfg-apikey');
  if (prov === 'ollama') {
    apikeyInput.placeholder = 'No requerida (Ollama corre local)';
    apikeyInput.disabled = true;
    apikeyInput.value = '';
  } else {
    apikeyInput.placeholder = 'Pegá tu API key aquí';
    apikeyInput.disabled = false;
  }
}

function openSettings() {
  qs('#cfg-provider').value = settings.provider || 'gemini';
  qs('#cfg-apikey').value = settings.apiKey || '';
  updateApiKeyHint();
  qs('#cfg-provider').onchange = updateApiKeyHint;
  
  // Sync model dropdown
  const modelSelect = qs('#cfg-model-select');
  const manualInput = qs('#cfg-model');
  const currentModel = settings.model || 'gemini-2.0-flash';
  
  let found = false;
  for (let opt of modelSelect.options) {
      if (opt.value === currentModel) {
          modelSelect.value = currentModel;
          found = true;
          break;
      }
  }
  
  if (!found) {
      modelSelect.value = 'custom';
      manualInput.value = currentModel;
      qs('#manual-model-group').style.display = 'block';
  } else {
      qs('#manual-model-group').style.display = 'none';
  }

  const toggle = qs('#toggle-autoexec');
  toggle.classList.toggle('on', !!settings.autoExec);
  const toggleCC = qs('#toggle-claudecode');
  if (toggleCC) toggleCC.classList.toggle('on', !!settings.claudeCode);
  qs('#settings-modal').classList.add('open');
}

function closeSettings() {
  qs('#settings-modal').classList.remove('open');
}

function saveSettings() {
  settings.provider = qs('#cfg-provider').value;
  
  const modelSelect = qs('#cfg-model-select');
  if (modelSelect.value === 'custom') {
      settings.model = qs('#cfg-model').value.trim();
  } else {
      settings.model = modelSelect.value;
  }

  settings.apiKey = qs('#cfg-apikey').value.trim();
  settings.autoExec = qs('#toggle-autoexec').classList.contains('on');
  autoExec = settings.autoExec;
  settings.claudeCode = qs('#toggle-claudecode').classList.contains('on');
  localStorage.setItem('oc_settings', JSON.stringify(settings));
  applyClaudeCodeSetting();
  closeSettings();
  addMessage('✓ Configuración guardada.', 'system');
}

// ─── MARKDOWN SIMPLE ──────────────────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1"><a href="$2" download class="download-link">Descargar imagen</a>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\n/g, '<br>');
}

// ─── DISCONNECT ───────────────────────────────────────────────────────────────
function disconnectAll() {
  [eventsWS, terminalWS, screenWS].forEach(ws => { if (ws) ws.close(); });
  eventsWS = terminalWS = screenWS = null;
}

// ─── VISUAL VIEWPORT (keyboard avoidance) ─────────────────────────────────────
// Cuando el teclado virtual se abre, visualViewport.height se reduce al área
// visible sobre el teclado. Ajustamos #app a ese tamaño para que todo el
// layout de Flexbox (header → content → tab-bar) se recalcule dentro del
// espacio visible. El tab-bar queda oculto por CSS (.keyboard-open) y el
// input del chat queda justo arriba del teclado, estilo WhatsApp.
function setupViewportFix() {
  const app = qs('#app');
  if (!window.visualViewport) return;

  let rafId = null;
  function onViewportChange() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      const offsetTop = vv.offsetTop || 0;
      const kbHeight = Math.max(0, window.innerHeight - vv.height - offsetTop);
      const isKeyboardOpen = kbHeight > 50;

      if (isKeyboardOpen) {
        // Teclado abierto: ajustar al viewport visible para que el input
        // quede justo sobre el teclado (estilo WhatsApp).
        app.style.top    = offsetTop + 'px';
        app.style.height = vv.height + 'px';
      } else {
        // Sin teclado: dejar que position:fixed + inset:0 + 100dvh
        // ocupen todo el alto de pantalla de borde a borde.
        app.style.top    = '';
        app.style.height = '';
      }

      app.classList.toggle('keyboard-open', isKeyboardOpen);

      // Re-ajustar el terminal activo si el viewport cambia (teclado abr/cierra)
      if (activeTermId && terminals[activeTermId]) {
        try { terminals[activeTermId].fit.fit(); } catch {}
      }
    });
  }

  window.visualViewport.addEventListener('resize', onViewportChange);
  window.visualViewport.addEventListener('scroll', onViewportChange);
  onViewportChange();
}

// ─── AUTORESPONDER UI ────────────────────────────────────────────────────────
async function arSetMode(mode) {
  const token = localStorage.getItem('oc_token') || '';
  try {
    const res = await fetch('/api/messaging/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (data.ok) {
      arHighlightMode(mode);
      const statusEl = qs('#autoresponder-status-msg');
      const modeLabels = { AUTO: '⚡ AUTO — Responde automáticamente', SEMI: '👁 SEMI — Requiere aprobación', PAUSADO: '⏸ PAUSADO — Sin respuestas automáticas' };
      if (statusEl) statusEl.textContent = modeLabels[mode] || mode;
    }
  } catch(e) { console.error('arSetMode:', e); }
}

function arHighlightMode(mode) {
  const modes = ['auto', 'semi', 'pausado'];
  const colors = { auto: 'var(--green)', semi: 'var(--orange)', pausado: 'var(--red)' };
  modes.forEach(m => {
    const btn = qs(`#ar-btn-${m}`);
    if (!btn) return;
    const isActive = m === mode.toLowerCase();
    btn.style.background = isActive ? colors[m] : 'var(--surface2)';
    btn.style.color = isActive ? '#fff' : 'var(--text2)';
    btn.style.borderColor = isActive ? colors[m] : 'var(--border)';
    btn.style.fontWeight = isActive ? '800' : '700';
  });
}

async function arApprove(pendingId) {
  const token = localStorage.getItem('oc_token') || '';
  try {
    await fetch(`/api/messaging/approve/${pendingId}`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token }
    });
    await refreshMessagingStatus();
  } catch(e) { alert('Error al aprobar: ' + e.message); }
}

async function arReject(pendingId) {
  const token = localStorage.getItem('oc_token') || '';
  try {
    await fetch(`/api/messaging/reject/${pendingId}`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token }
    });
    await refreshMessagingStatus();
  } catch(e) { alert('Error al rechazar: ' + e.message); }
}

// ─── MENSAJERÍA ───────────────────────────────────────────────────────────────

let waQrPoller = null;

async function refreshMessagingStatus() {
  try {
    const res = await fetch('/api/messaging/status', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') } });
    if (!res.ok) return;
    const data = await res.json();
    updateWaUI(data.whatsapp);
    updateFbUI(data.messenger);
    // Autoresponder
    const arEl = qs('#autoresponder-status-msg');
    if (arEl && data.autoresponder) {
      const ar = data.autoresponder;
      arEl.textContent = ar.enabled
        ? `Activo — ${ar.rules?.length || 0} regla(s) configurada(s)`
        : 'Desactivado';
      arEl.style.color = ar.enabled ? 'var(--green)' : 'var(--text3)';
    }
  } catch (e) {
    console.error('refreshMessagingStatus:', e);
  }
}

function updateWaUI(wa) {
  if (!wa) return;
  const dot = qs('#wa-status-dot');
  const txt = qs('#wa-status-text');
  const qrBox = qs('#wa-qr-box');
  const qrImg = qs('#wa-qr-img');
  const btnStart = qs('#btn-wa-start');
  const btnStop = qs('#btn-wa-stop');

  const statusMap = {
    disconnected:  { label: 'Desconectado', color: 'var(--text3)' },
    starting:      { label: 'Iniciando...', color: 'var(--orange)' },
    qr_pending:    { label: 'Esperando escaneo QR', color: 'var(--orange)' },
    phone_pending: { label: 'Generando código...', color: 'var(--orange)' },
    authenticated: { label: 'Autenticado', color: 'var(--orange)' },
    ready:         { label: 'Conectado ✓', color: 'var(--green)' },
    error:         { label: 'Error', color: 'var(--red)' },
  };
  const s = statusMap[wa.status] || { label: wa.status, color: 'var(--text3)' };
  if (dot) dot.style.background = s.color;
  if (txt) txt.textContent = s.label + (wa.error ? ` — ${wa.error}` : '');

  const isReady = wa.status === 'ready';
  const tabs = qs('#wa-login-tabs');
  if (btnStart) btnStart.style.display = isReady ? 'none' : 'flex';
  if (btnStop)  btnStop.style.display  = isReady ? 'flex' : 'none';
  if (tabs)     tabs.style.display     = isReady ? 'none' : 'flex';

  // Mostrar pairing code si llegó — cambiar al tab phone automáticamente
  if (wa.pairingCode) {
    const codeEl  = qs('#wa-pairing-code');
    const codeBox = qs('#wa-pairing-code-box');
    if (codeEl && codeEl.textContent !== wa.pairingCode) {
      codeEl.textContent  = wa.pairingCode;
      if (codeBox) codeBox.style.display = 'block';
      if (txt) txt.textContent = '📋 Ingresá este código en WhatsApp';
    }
    // Siempre asegurar que el tab teléfono está visible
    waSetTab('phone');
    startWaQrPoller(); // seguir esperando que se autentique
  }

  if (wa.status === 'qr_pending' && wa.qr) {
    const phoneBox = qs('#wa-phone-box');
    if (qrBox && (!phoneBox || phoneBox.style.display === 'none')) {
      if (qrImg) qrImg.src = wa.qr;
      if (qrBox) qrBox.style.display = 'block';
    } else if (qrImg) {
      qrImg.src = wa.qr;
    }
    startWaQrPoller();
  } else if (!isReady) {
    if (qrBox && wa.status !== 'qr_pending') qrBox.style.display = 'none';
    if (wa.status === 'disconnected' || wa.status === 'error') stopWaQrPoller();
  } else {
    if (qrBox) qrBox.style.display = 'none';
    stopWaQrPoller();
  }
}

function updateFbUI(fb) {
  if (!fb) return;
  const dot = qs('#fb-status-dot');
  const txt = qs('#fb-status-text');
  const loginForm = qs('#fb-login-form');
  const twoFaBox = qs('#fb-2fa-box');
  const btnStart = qs('#btn-fb-start');
  const btnStop  = qs('#btn-fb-stop');
  const userBadge = qs('#fb-user-badge');

  const statusMap = {
    disconnected: { label: 'Desconectado', color: 'var(--text3)' },
    starting:     { label: 'Iniciando...', color: 'var(--orange)' },
    logging_in:   { label: 'Iniciando sesión...', color: 'var(--orange)' },
    needs_2fa:    { label: 'Requiere verificación', color: 'var(--orange)' },
    ready:        { label: 'Conectado ✓', color: 'var(--green)' },
    error:        { label: 'Error', color: 'var(--red)' },
  };
  const s = statusMap[fb.status] || { label: fb.status, color: 'var(--text3)' };
  if (dot) dot.style.background = s.color;

  const isReady = fb.status === 'ready';
  const needs2fa = fb.status === 'needs_2fa';

  // Mostrar nombre de usuario cuando está conectado
  if (isReady && (fb.username || fb.email)) {
    const displayName = fb.username || fb.email;
    if (txt) txt.textContent = `Conectado como: ${displayName}`;
    if (userBadge) {
      userBadge.textContent = `👤 ${displayName}`;
      userBadge.style.display = 'inline-block';
    }
  } else {
    if (txt) txt.textContent = s.label + (fb.error ? ` — ${fb.error}` : '');
    if (userBadge) userBadge.style.display = 'none';
  }

  if (loginForm) loginForm.style.display = isReady ? 'none' : 'flex';
  if (twoFaBox)  twoFaBox.style.display  = needs2fa ? 'block' : 'none';
  if (btnStart)  btnStart.style.display  = isReady ? 'none' : 'flex';
  if (btnStop)   btnStop.style.display   = isReady ? 'flex' : 'none';
}

async function waStart() {
  const btn = qs('#btn-wa-start');
  if (btn) { btn.disabled = true; btn.textContent = 'Iniciando...'; }
  try {
    await fetch('/api/messaging/whatsapp/start', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
    });
    await refreshMessagingStatus();
    startWaQrPoller();
  } catch (e) {
    console.error('waStart:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="power" style="width:14px;height:14px;"></i> Conectar'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
  }
}

async function waStop() {
  await fetch('/api/messaging/whatsapp/stop', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
  });
  stopWaQrPoller();
  await refreshMessagingStatus();
}

function startWaQrPoller() {
  if (waQrPoller) return;
  waQrPoller = setInterval(async () => {
    try {
      const res = await fetch('/api/messaging/whatsapp/qr', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') } });
      const data = await res.json();

      if (data.status === 'ready' || data.status === 'authenticated') {
        stopWaQrPoller();
        await refreshMessagingStatus();
        return;
      }

      // Pairing code por teléfono
      if (data.pairingCode) {
        const codeEl  = qs('#wa-pairing-code');
        const codeBox = qs('#wa-pairing-code-box');
        const stTxt   = qs('#wa-status-text');
        if (codeEl && codeEl.textContent !== data.pairingCode) {
          codeEl.textContent = data.pairingCode;
          if (codeBox) codeBox.style.display = 'block';
          if (stTxt)   stTxt.textContent = 'Ingresá el código en WhatsApp';
          // Asegurar que el tab teléfono esté visible
          waSetTab('phone');
        }
        return; // seguir esperando
      }

      // QR normal
      if (data.status === 'qr_pending' && data.qr) {
        const img = qs('#wa-qr-img');
        if (img) img.src = data.qr;
        const phoneBox = qs('#wa-phone-box');
        const qrBox = qs('#wa-qr-box');
        if (qrBox && (!phoneBox || phoneBox.style.display === 'none')) {
          qrBox.style.display = 'block';
        }
        const txt = qs('#wa-status-text');
        if (txt) txt.textContent = 'Esperando escaneo QR';
        const dot = qs('#wa-status-dot');
        if (dot) dot.style.background = 'var(--orange)';
      } else {
        await refreshMessagingStatus();
      }
    } catch {}
  }, 4000);
}

function stopWaQrPoller() {
  if (waQrPoller) { clearInterval(waQrPoller); waQrPoller = null; }
}

// Toggle entre tab QR y tab Teléfono
function waSetTab(tab) {
  const tabQR    = qs('#wa-tab-qr');
  const tabPhone = qs('#wa-tab-phone');
  const qrBox    = qs('#wa-qr-box');
  const phoneBox = qs('#wa-phone-box');
  const pairBox  = qs('#wa-pairing-code-box');

  if (tab === 'qr') {
    if (tabQR)    { tabQR.style.background = 'var(--accent)'; tabQR.style.color = '#fff'; tabQR.style.borderColor = 'var(--accent)'; }
    if (tabPhone) { tabPhone.style.background = 'var(--surface)'; tabPhone.style.color = 'var(--text2)'; tabPhone.style.borderColor = 'var(--border)'; }
    // Mostrar QR si hay uno disponible
    const img = qs('#wa-qr-img');
    if (qrBox && img && img.src && img.src !== window.location.href) {
      qrBox.style.display = 'block';
    }
    if (phoneBox) phoneBox.style.display = 'none';
  } else {
    if (tabPhone) { tabPhone.style.background = 'var(--accent)'; tabPhone.style.color = '#fff'; tabPhone.style.borderColor = 'var(--accent)'; }
    if (tabQR)    { tabQR.style.background = 'var(--surface)'; tabQR.style.color = 'var(--text2)'; tabQR.style.borderColor = 'var(--border)'; }
    if (qrBox)    qrBox.style.display = 'none';
    if (phoneBox) phoneBox.style.display = 'block';
    if (pairBox)  pairBox.style.display = 'none';
  }
}

async function waRequestPhoneCode() {
  const inputEl = qs('#wa-phone-input');
  const rawValue = inputEl ? String(inputEl.value || '') : '';
  const phone = rawValue.replace(/[^0-9]/g, '');

  if (!phone || phone.length < 8) {
    alert('Ingresá un número válido (solo dígitos, con código de país)\nArgentina sin el 9: 543455237843');
    return;
  }

  const btn = qs('#btn-wa-phone-code');
  const statusTxt = qs('#wa-status-text');

  if (btn) { btn.disabled = true; btn.textContent = 'Iniciando...'; }
  if (statusTxt) statusTxt.textContent = 'Arrancando WhatsApp (~20s)...';

  try {
    // Detener si estaba en estado de error o QR para reiniciar en modo teléfono
    const statusRes = await fetch('/api/messaging/status', {
      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
    });
    const statusData = await statusRes.json();
    const curSt = statusData?.whatsapp?.status || 'disconnected';

    if (curSt === 'ready' || curSt === 'authenticated') {
      alert('WhatsApp ya está conectado. Desconectá primero.');
      return;
    }

    // Si estaba en modo QR o error, parar primero para empezar modo teléfono
    if (curSt === 'qr_pending' || curSt === 'error') {
      await fetch('/api/messaging/whatsapp/stop', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
      });
      await new Promise(r => setTimeout(r, 1000));
    }

    // Arrancar en modo teléfono (el backend pasa el número al evento qr)
    if (btn) btn.textContent = 'Cargando Chromium...';
    const startRes = await fetch('/api/messaging/whatsapp/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') },
      body: JSON.stringify({ phone: phone })
    });
    await startRes.json();

    if (btn) btn.textContent = 'Esperando código...';
    if (statusTxt) statusTxt.textContent = 'Generando código de vinculación...';

    // El poller va a detectar el pairingCode y mostrarlo automáticamente
    startWaQrPoller();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Obtener código'; }
  }
}

async function fbStart() {
  const email = (qs('#fb-email')?.value || '').trim();
  const pass  = (qs('#fb-pass')?.value  || '').trim();
  if (!email || !pass) { alert('Ingresá email y contraseña de Facebook'); return; }

  const btn = qs('#btn-fb-start');
  if (btn) { btn.disabled = true; btn.textContent = 'Conectando...'; }
  try {
    const res = await fetch('/api/messaging/messenger/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') },
      body: JSON.stringify({ email, password: pass })
    });
    const data = await res.json();
    if (data.needs2fa) {
      const twoFa = qs('#fb-2fa-box');
      if (twoFa) twoFa.style.display = 'block';
    }
    await refreshMessagingStatus();
  } catch (e) {
    console.error('fbStart:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="log-in" style="width:14px;height:14px;"></i> Conectar'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
  }
}

async function fbStop() {
  await fetch('/api/messaging/messenger/stop', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
  });
  await refreshMessagingStatus();
}

async function fbRetry2FA() {
  const res = await fetch('/api/messaging/messenger/retry2fa', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') }
  });
  const data = await res.json();
  if (!data.ok) { alert('Error: ' + (data.error || 'No se pudo verificar')); return; }
  await refreshMessagingStatus();
}

// ─── JARVIS VOICE ASSISTANT ───────────────────────────────────────────────────
let lastQueryWasVoice = false; // true when last query was sent via microphone
let jarvisMode     = false;
let jarvisRec      = null;   // wake word SpeechRecognition instance
let jarvisCapturing = false; // true while recording a command
let jarvisReady    = false;  // browser supports SpeechRecognition
let jarvisVoice    = null;   // Selected masculine voice
const WAKE_WORDS   = ['hey jarvis', 'oye jarvis', 'jarvis'];

const isIOS = () => {
  return [
    'iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'
  ].includes(navigator.platform) || (navigator.userAgent.includes("Mac") && "ontouchend" in document);
};

function updateJarvisVoice() {
  if (!window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    console.log("🔊 Esperando a que el navegador cargue las voces...");
    return;
  }
  
  // Buscar voces masculinas en español — ordenadas de más grave a más neutral
  // iOS/Safari: Jorge, Juan, Diego, Jordi
  const preferred = [
    'alvaro', 'raul', 'carlos', 'antonio', 'hector', 'andrés', 'andres',
    'jorge', 'juan', 'diego', 'jordi',
    'pablo', 'david', 'microsoft helio', 'google español', 'espíritu', 'enrique', 'miguel',
    'microsoft raul', 'google castilian spanish male', 'spanish (argentina) male'
  ];
  
  const esVoices = voices.filter(v => v.lang.startsWith('es'));
  if (esVoices.length === 0) {
    // Si no hay español, intentar inglés o cualquiera para no quedar mudo (fallback total)
    jarvisVoice = voices.find(v => v.default) || voices[0];
    console.log("⚠️ No se encontraron voces en español. Usando:", jarvisVoice.name);
    return;
  }

  // 1. Buscar coincidencia exacta por nombre preferido (masculinas)
  for (const name of preferred) {
    const found = esVoices.find(v => v.name.toLowerCase().includes(name));
    if (found) {
      jarvisVoice = found;
      console.log("🤖 JARVIS Voice selected (Preferred):", found.name);
      return;
    }
  }

  // 2. Heurística para evitar voces femeninas conocidas si no hay preferred
  const femaleKeywords = ['helena', 'sabina', 'zira', 'laura', 'monica', 'elsa', 'hilda', 'susan', 'stella', 'paulina', 'carmen', 'rosa', 'maria', 'isabela', 'valentina', 'lucia'];
  const maleFallback = esVoices.find(v => !femaleKeywords.some(f => v.name.toLowerCase().includes(f)));
  
  jarvisVoice = maleFallback || esVoices[0];
  console.log("🤖 JARVIS Voice selected (Fallback):", jarvisVoice.name);
}

// Cargar voces al inicio y cuando cambian
if (window.speechSynthesis) {
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = updateJarvisVoice;
  }
  updateJarvisVoice();
  // Retry: algunos navegadores tardan en poblar la lista
  setTimeout(updateJarvisVoice, 500);
  setTimeout(updateJarvisVoice, 1500);
}

// Chrome bug: speechSynthesis se pausa solo si la página lleva un rato abierta
setInterval(() => {
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    window.speechSynthesis.pause();
    window.speechSynthesis.resume();
  }
}, 10000);

function initJarvis() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // not supported — buttons stay hidden
  jarvisReady = true;
  const toggleBtn = qs('#btn-jarvis-toggle');
  if (toggleBtn) toggleBtn.style.display = 'flex';
}

function toggleJarvisMode() {
  if (!jarvisReady) {
    addMessage('Tu navegador no soporta reconocimiento de voz. Usá Chrome o Edge.', 'system');
    return;
  }
  jarvisMode = !jarvisMode;
  const btn = qs('#btn-jarvis-toggle');
  if (jarvisMode) {
    btn.classList.add('jarvis-on');
    btn.title = 'JARVIS activo — clic para desactivar';
    jarvisBadge('wake', 'JARVIS escuchando...');
    startKeepAlive();
    startWakeListener();
  } else {
    btn.classList.remove('jarvis-on');
    btn.title = 'Activar JARVIS (wake word)';
    stopWakeListener();
    stopKeepAlive();
    jarvisBadgeHide();
  }
}

function startWakeListener() {
  if (!jarvisReady || !jarvisMode || jarvisCapturing) return;
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    jarvisRec = new SR();
    
    // iOS Safari no soporta continuous: true correctamente y puede congelar la UI
    jarvisRec.continuous = !isIOS(); 
    jarvisRec.interimResults = true;
    jarvisRec.lang = 'es-AR';

    jarvisRec.onresult = (e) => {
      if (jarvisCapturing) return;
      const full = Array.from(e.results).map(r => r[0].transcript.toLowerCase()).join(' ');
      for (const w of WAKE_WORDS) {
        if (full.includes(w)) {
          stopWakeListener();
          captureCommand();
          break;
        }
      }
    };

    jarvisRec.onend = () => {
      jarvisRec = null;
      if (jarvisMode && !jarvisCapturing) {
        // Delay más largo en iOS para evitar bloqueos por reinicio rápido
        setTimeout(() => startWakeListener(), isIOS() ? 1000 : 400);
      }
    };

    jarvisRec.onerror = (e) => {
      console.warn("🎙️ WakeListener error:", e.error);
      jarvisRec = null;
      if (e.error === 'no-speech') return;
      if (jarvisMode && !jarvisCapturing) {
        setTimeout(() => startWakeListener(), isIOS() ? 2000 : 1200);
      }
    };

    jarvisRec.start();
  } catch (err) {
    console.error("❌ Error iniciando WakeListener:", err);
    jarvisReady = false;
  }
}

function stopWakeListener() {
  if (jarvisRec) { try { jarvisRec.stop(); } catch(e) {} jarvisRec = null; }
}

function captureCommand() {
  jarvisCapturing = true;
  jarvisBadge('cmd', 'Te escucho...');
  speakJarvis('Dime');

  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'es-AR';

    const timeout = setTimeout(() => { try { rec.stop(); } catch(e) {} }, 8000);

    rec.onresult = (e) => {
      clearTimeout(timeout);
      const cmd = e.results[0][0].transcript.trim();
      if (cmd) {
        if (!qs('#panel-chat').classList.contains('active')) switchPanel('chat');
        lastQueryWasVoice = true;
        qs('#chat-input').value = cmd;
        sendChatMessage();
      }
    };

    const done = () => {
      clearTimeout(timeout);
      jarvisCapturing = false;
      if (jarvisMode) { 
        jarvisBadge('wake', 'JARVIS escuchando...'); 
        setTimeout(() => startWakeListener(), 500); 
      }
      else jarvisBadgeHide();
    };
    rec.onend = done;
    rec.onerror = (e) => { console.warn("🎙️ Capture error:", e.error); done(); };

    rec.start();
  } catch (err) {
    console.error("❌ Error en captureCommand:", err);
    jarvisCapturing = false;
    if (jarvisMode) startWakeListener();
  }
}

// ── Manual mic button ──
let manualRec = null;
function toggleManualMic() {
  if (!jarvisReady) {
    addMessage('Tu navegador no soporta reconocimiento de voz. Usá Chrome o Edge.', 'system');
    return;
  }
  const btn = qs('#btn-mic');
  if (manualRec) {
    try { manualRec.stop(); } catch(e) {}
    manualRec = null;
    btn.classList.remove('listening');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  manualRec = new SR();
  manualRec.continuous = false;
  manualRec.interimResults = false;
  manualRec.lang = 'es-AR';
  btn.classList.add('listening');

  manualRec.onresult = (e) => {
    const text = e.results[0][0].transcript.trim();
    if (text) { lastQueryWasVoice = true; qs('#chat-input').value = text; sendChatMessage(); }
  };
  const stopManual = () => { btn.classList.remove('listening'); manualRec = null; };
  manualRec.onend = stopManual;
  manualRec.onerror = stopManual;
  try { manualRec.start(); } catch(e) { stopManual(); }
}

// ── Background keepalive — audio silencioso para evitar suspensión (Android) ──
let _keepAliveCtx = null;
let _keepAliveSrc = null;
function startKeepAlive() {
  if (_keepAliveCtx) return;
  try {
    _keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = _keepAliveCtx.createBuffer(1, _keepAliveCtx.sampleRate, _keepAliveCtx.sampleRate);
    _keepAliveSrc = _keepAliveCtx.createBufferSource();
    _keepAliveSrc.buffer = buf;
    _keepAliveSrc.loop = true;
    _keepAliveSrc.connect(_keepAliveCtx.destination);
    _keepAliveSrc.start();
  } catch(e) {}
}
function stopKeepAlive() {
  try { _keepAliveSrc && _keepAliveSrc.stop(); } catch(e) {}
  try { _keepAliveCtx && _keepAliveCtx.close(); } catch(e) {}
  _keepAliveSrc = null;
  _keepAliveCtx = null;
}

// ── Notificación de respuesta JARVIS ──
function jarvisNotify(text) {
  const clean = text
    .replace(/```[\s\S]*?```/g, '[código]')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, 200);
  if (clean) ccNotify('🤖 JARVIS', clean, 'jarvis-response');
}

// ── TTS ──
function _doSpeak(text, rate, pitch) {
  if (!window.speechSynthesis) return;
  if (!text) return;
  logDebug("TTS: Intentando hablar... " + text.slice(0, 20));

  if (!jarvisVoice) updateJarvisVoice();
  window.speechSynthesis.cancel();
  
  // Extra help for Safari: try to resume just before speaking
  if (window.speechSynthesis.paused) window.speechSynthesis.resume();

  setTimeout(() => {
    try {
      window.speechSynthesis.resume();
      if (!jarvisVoice) updateJarvisVoice();

      const utt = new SpeechSynthesisUtterance(text);
      if (jarvisVoice) {
        utt.voice = jarvisVoice;
        utt.lang = jarvisVoice.lang;
      } else {
        utt.lang = 'es-AR';
      }

      utt.rate = rate;
      utt.pitch = pitch;
      utt.volume = 1.0;

      utt.onstart = () => logDebug("🗣️ JARVIS hablando...");
      utt.onerror = (e) => {
        logDebug("🔇 TTS Error: " + e.error);
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
           window.speechSynthesis.cancel();
           window.speechSynthesis.resume();
        }
      };
      
      window.speechSynthesis.speak(utt);
    } catch (err) {
      logDebug("TTS Fatal Error: " + err.message);
    }
  }, 100);
}

function speakJarvis(text) {
  if (!window.speechSynthesis || !jarvisMode) return;
  // Jarvis: tono formal, un poco más grave y pausado
  _doSpeak(text, 0.9, 0.5);
}

function speakResponse(text) {
  if (!window.speechSynthesis || (!jarvisMode && !lastQueryWasVoice)) return;
  
  // Limpiar texto para lectura
  const clean = text
    .replace(/```[\s\S]*?```/g, 'Aquí tienes el código.')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  if (clean.length === 0) return;

  if (jarvisMode) {
    speakJarvis(clean);
  } else {
    lastQueryWasVoice = false;
    _doSpeak(clean.slice(0, 500), 0.9, 0.55);
  }
}

// ── Badge helpers ──
function jarvisBadge(mode, text) {
  const b = qs('#jarvis-badge');
  b.className = 'active' + (mode === 'cmd' ? ' cmd' : '');
  qs('#jarvis-badge-text').textContent = text;
}
function jarvisBadgeHide() { qs('#jarvis-badge').className = ''; }

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { 
  init(); 
  setupViewportFix(); 
  
  // iOS AUDIO UNLOCKER: Safari requiere al menos una interacción para habilitar TTS
  const unlockAudio = () => {
    logDebug("🔊 Intentando desbloquear audio...");
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(' ');
      utt.volume = 0;
      window.speechSynthesis.speak(utt);
    }
    // Forzar AudioContext
    if (!_keepAliveCtx) startKeepAlive();
    else if (_keepAliveCtx.state === 'suspended') _keepAliveCtx.resume();
    
    // Play a tiny silent buffer via Audio API (more effective in PWA)
    try {
      const ctx = _keepAliveCtx || new (window.AudioContext || window.webkitAudioContext)();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      logDebug("✅ Audio Context Blessed");
    } catch(e) { logDebug("⚠️ Audio Blessing Failed: " + e.message); }

    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
  };
  document.addEventListener('click', unlockAudio);
  document.addEventListener('touchstart', unlockAudio);
});

// ─── CANVA ─────────────────────────────────────────────────────────────────────
const _canvaToken = () => localStorage.getItem('oc_token') || '';

async function refreshCanvaStatus() {
  try {
    const res = await fetch('/api/canva/status', { headers: { 'Authorization': 'Bearer ' + _canvaToken() } });
    const data = await res.json();
    const dc = qs('#canva-disconnected');
    const cc = qs('#canva-connected');
    const createSec = qs('#canva-create-section');
    const designsSec = qs('#canva-designs-section');

    if (data.connected) {
      dc.style.display = 'none';
      cc.style.display = '';
      createSec.style.display = '';
      designsSec.style.display = '';
      const p = data.profile;
      qs('#canva-user-name').textContent = p?.display_name || p?.email || p?.user_name || 'cuenta vinculada';
      loadCanvaDesigns();
    } else {
      dc.style.display = '';
      cc.style.display = 'none';
      createSec.style.display = 'none';
      designsSec.style.display = 'none';
    }
  } catch (e) {
    console.error('refreshCanvaStatus:', e);
  }
}

function connectCanva() {
  // Abrir flujo OAuth en popup (Canva cierra la ventana al terminar)
  const popup = window.open('/auth/canva', 'canva_oauth', 'width=600,height=700,scrollbars=yes');
  const listener = (e) => {
    if (e.data?.canva === 'connected') {
      window.removeEventListener('message', listener);
      if (popup && !popup.closed) popup.close();
      refreshCanvaStatus();
    } else if (e.data?.canva === 'error') {
      window.removeEventListener('message', listener);
      alert('Error al conectar Canva: ' + (e.data.msg || 'desconocido'));
    }
  };
  window.addEventListener('message', listener);
  // Fallback: si el popup cierra sin postMessage, revisar estado
  const pollClose = setInterval(() => {
    if (popup && popup.closed) {
      clearInterval(pollClose);
      window.removeEventListener('message', listener);
      setTimeout(refreshCanvaStatus, 500);
    }
  }, 800);
}

async function disconnectCanva() {
  if (!confirm('¿Desconectar tu cuenta de Canva?')) return;
  await fetch('/api/canva/disconnect', { method: 'POST', headers: { 'Authorization': 'Bearer ' + _canvaToken() } });
  refreshCanvaStatus();
}

async function loadCanvaDesigns() {
  const list = qs('#canva-designs-list');
  if (!list) return;
  list.textContent = 'Cargando...';
  try {
    const res = await fetch('/api/canva/designs', { headers: { 'Authorization': 'Bearer ' + _canvaToken() } });
    const data = await res.json();
    const designs = data.designs || data.items || [];
    if (!designs.length) { list.textContent = 'No se encontraron diseños.'; return; }
    list.innerHTML = designs.slice(0, 20).map(d => {
      const editUrl = d.urls?.edit_url || d.edit_url || '#';
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${d.title || d.id || 'Sin título'}</span>
        ${editUrl !== '#' ? `<a href="${editUrl}" target="_blank" rel="noopener"
          style="font-size:11px;color:var(--accent);text-decoration:none;white-space:nowrap">Editar ↗</a>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    list.textContent = 'Error: ' + e.message;
  }
}

async function createCanvaDesign() {
  const type  = qs('#canva-design-type').value;
  const title = qs('#canva-design-title').value.trim() || `Nuevo ${type}`;
  const btn   = qs('#btn-canva-create');
  const result = qs('#canva-create-result');
  btn.disabled = true;
  btn.textContent = 'Creando...';
  result.style.display = 'none';
  try {
    const res = await fetch('/api/canva/designs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _canvaToken() },
      body: JSON.stringify({ design_type: type, title })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const design = data.design || data;
    const editUrl = design.urls?.edit_url || design.edit_url;
    result.style.display = '';
    result.innerHTML = editUrl
      ? `✅ Diseño creado: <a href="${editUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${title} ↗</a>`
      : `✅ Diseño creado (ID: ${design.id})`;
    loadCanvaDesigns();
  } catch (e) {
    result.style.display = '';
    result.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear en Canva';
  }
}