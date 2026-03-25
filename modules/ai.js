// modules/ai.js — Adaptador multi-proveedor: Gemini + DeepSeek
const { executeCommand } = require('./terminal');
const browser = require('./browser');
const whatsapp = require('./whatsapp');
const messenger = require('./messenger');
const canva    = require('./canva');
const aiTools = require('./tools');
const fs = require('fs');
const path = require('path');

// Proveedores disponibles
const PROVIDERS = {
  gemini: 'gemini',
  deepseek: 'deepseek',
  ollama: 'ollama'
};

// ─── PERSISTENCIA DE HISTORIAL EN DISCO ───────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, '../data/chat_sessions.json');
let _saveTimer = null;

// Historial de conversación por sesión
const chatHistories = new Map();
const sessionApiKeys = new Map(); // Store API key per session for tool execution
const abortSignals = new Map(); // Store abort state per session

function abortChat(sessionId) {
  abortSignals.set(sessionId, true);
}

function loadPersistedHistories() {
  try {
    if (!fs.existsSync(path.join(__dirname, '../data'))) {
      fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
    }
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      let count = 0;
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) && value.length > 0) {
          chatHistories.set(key, value);
          count++;
        }
      }
      console.log(`📚 Historial IA cargado: ${count} sesión(es) restaurada(s)`);
    }
  } catch (e) {
    console.error('⚠️  Error cargando historial IA:', e.message);
  }
}

function saveHistories() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const obj = {};
      for (const [key, value] of chatHistories.entries()) {
        // Serializar de forma segura: limpiar partes con datos binarios grandes (imágenes base64)
        obj[key] = JSON.parse(JSON.stringify(value, (k, v) => {
          // Reemplazar datos base64 largos con placeholder para no inflar el archivo
          if (typeof v === 'string' && v.length > 8000 && /^[A-Za-z0-9+/]+=*$/.test(v.slice(0, 100))) {
            return '[datos_binarios_omitidos]';
          }
          return v;
        }));
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('⚠️  Error guardando historial IA:', e.message);
    }
  }, 1500);
}

// Cargar historial al iniciar
loadPersistedHistories();

// Herramientas que la IA puede usar (modularizadas)
const AI_TOOLS = aiTools.definitions;

// Ejecutar herramienta real
async function runTool(toolName, args, onToolCall, apiKey) {
  const handler = aiTools.handlers[toolName];
  if (!handler) return `Herramienta desconocida: ${toolName}`;
  
  try {
    const result = await handler(args, { onToolCall, apiKey });
    return result;
  } catch (err) {
    console.error(`Error ejecutando tool ${toolName}:`, err);
    return `Error en la herramienta ${toolName}: ${err.message}`;
  }
}


// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function chatWithGemini(apiKey, selectedModel, message, sessionId, autoExecute, onToolCall, activeSkillId = null) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  console.log('DEBUG: Usando modelo:', selectedModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite');
  const model = genAI.getGenerativeModel({
    model: selectedModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
    systemInstruction: getSystemPrompt(activeSkillId),
    tools: [{
      functionDeclarations: aiTools.getGeminiTools()
    }],
    toolConfig: { functionCallingConfig: { mode: autoExecute ? 'AUTO' : 'ANY' } }
  });

  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);

  const chat = model.startChat({ history });

  // Indicar que esta sesión NO está abortada
  abortSignals.delete(sessionId);

  let result = await chat.sendMessage(message);
  let response = result.response;

  // Manejar function calls en loop
  let calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : [];
  let _toolCounter = 0;
  while (calls && calls.length > 0) {
    // VERIFICAR ABORTADO
    if (abortSignals.get(sessionId)) {
      abortSignals.delete(sessionId);
      return 'Ejecución cancelada por el usuario.';
    }

    const functionResponses = [];

    for (const call of calls) {
      let toolResult;
      const isAutoTool = call.name !== 'execute_command';
      const toolId = `tc_${Date.now()}_${_toolCounter++}`;
      if (autoExecute || isAutoTool) {
        onToolCall && onToolCall({ type: 'executing', name: call.name, args: call.args, toolId });
        toolResult = await runTool(call.name, call.args, onToolCall, apiKey);
        onToolCall && onToolCall({ type: 'result', name: call.name, result: toolResult, toolId });
      } else {
        // Modo confirmación: pausar y esperar
        toolResult = await waitForConfirmation(sessionId, call.name, call.args, onToolCall, toolId);
        onToolCall && onToolCall({ type: 'result', name: call.name, result: toolResult, toolId });
      }
      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: { result: toolResult }
        }
      });
    }

    result = await chat.sendMessage(functionResponses);
    response = result.response;
    calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : [];
  }

  // Guardar historial COMPLETO (incluye tool calls y resultados) para que el AI recuerde todo
  try {
    const fullHistory = chat.getHistory();
    // Mantener máximo 60 turnos (30 intercambios user/model)
    const trimmed = fullHistory.length > 60 ? fullHistory.slice(fullHistory.length - 60) : fullHistory;
    chatHistories.set(sessionId, trimmed);
  } catch (e) {
    // Fallback: guardar solo texto si getHistory() falla
    history.push({ role: 'user', parts: [{ text: message }] });
    history.push({ role: 'model', parts: [{ text: response.text() }] });
    if (history.length > 40) history.splice(0, 2);
  }
  saveHistories();

  return response.text();
}

// ─── DEEPSEEK ─────────────────────────────────────────────────────────────────
async function chatWithDeepSeek(apiKey, selectedModel, message, sessionId, autoExecute, onToolCall, activeSkillId = null) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com'
  });

  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);

  const messages = [
    { role: 'system', content: getSystemPrompt(activeSkillId) },
    ...history,
    { role: 'user', content: message }
  ];

  const tools = aiTools.getOpenAITools();

  // Indicar que esta sesión NO está abortada
  abortSignals.delete(sessionId);

  let response = await client.chat.completions.create({
    model: selectedModel || 'deepseek-chat',
    messages,
    tools,
    tool_choice: 'auto'
  });

  let assistantMessage = response.choices[0].message;

  // Loop de tool calls
  let _dsToolCounter = 0;
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    // VERIFICAR ABORTADO
    if (abortSignals.get(sessionId)) {
      abortSignals.delete(sessionId);
      return 'Ejecución cancelada por el usuario.';
    }

    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let toolResult;
      const isAutoTool = toolCall.function.name !== 'execute_command';
      const toolId = `tc_${Date.now()}_${_dsToolCounter++}`;

      if (autoExecute || isAutoTool) {
        onToolCall && onToolCall({ type: 'executing', name: toolCall.function.name, args, toolId });
        toolResult = await runTool(toolCall.function.name, args, onToolCall, apiKey);
        onToolCall && onToolCall({ type: 'result', name: toolCall.function.name, result: toolResult, toolId });
      } else {
        toolResult = await waitForConfirmation(sessionId, toolCall.function.name, args, onToolCall, toolId);
        onToolCall && onToolCall({ type: 'result', name: toolCall.function.name, result: toolResult, toolId });
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }

    response = await client.chat.completions.create({
      model: selectedModel || 'deepseek-chat',
      messages,
      tools,
      tool_choice: 'auto'
    });
    assistantMessage = response.choices[0].message;
  }

  const finalText = assistantMessage.content || '';

  // Guardar historial COMPLETO incluyendo tool calls (messages[0] es el system prompt, lo omitimos)
  const fullHistory = messages.slice(1);
  if (fullHistory.length > 80) fullHistory.splice(0, fullHistory.length - 80);
  chatHistories.set(sessionId, fullHistory);
  saveHistories();

  return finalText;
}

// ─── OLLAMA (OpenAI-compatible, local) ────────────────────────────────────────
async function chatWithOllama(selectedModel, message, sessionId, autoExecute, onToolCall, activeSkillId = null) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey: 'ollama',                        // Ollama no valida la key
    baseURL: 'http://localhost:11434/v1'
  });

  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);

  const messages = [
    { role: 'system', content: getSystemPrompt(activeSkillId) },
    ...history,
    { role: 'user', content: message }
  ];

  // Ollama soporta tool_calls en modelos recientes; si falla, se degrada a sin tools
  const tools = aiTools.getOpenAITools();

  // Indicar que esta sesión NO está abortada
  abortSignals.delete(sessionId);

  let response;
  try {
    response = await client.chat.completions.create({
      model: selectedModel || 'qwen3:latest',
      messages,
      tools,
      tool_choice: 'auto'
    });
  } catch (err) {
    // Si el modelo no soporta tools, reintentar sin ellas
    console.warn('Ollama: tool_calls no soportados, reintentando sin tools:', err.message);
    response = await client.chat.completions.create({
      model: selectedModel || 'qwen3:latest',
      messages
    });
  }

  let assistantMessage = response.choices[0].message;

  // Loop de tool calls
  let _ollamaToolCounter = 0;
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    // VERIFICAR ABORTADO
    if (abortSignals.get(sessionId)) {
      abortSignals.delete(sessionId);
      return { content: 'Ejecución cancelada por el usuario.', thinking: '' };
    }

    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let toolResult;
      const isAutoTool = toolCall.function.name !== 'execute_command';
      const toolId = `tc_${Date.now()}_${_ollamaToolCounter++}`;

      if (autoExecute || isAutoTool) {
        onToolCall && onToolCall({ type: 'executing', name: toolCall.function.name, args, toolId });
        toolResult = await runTool(toolCall.function.name, args, onToolCall, null);
        onToolCall && onToolCall({ type: 'result', name: toolCall.function.name, result: toolResult, toolId });
      } else {
        toolResult = await waitForConfirmation(sessionId, toolCall.function.name, args, onToolCall, toolId);
        onToolCall && onToolCall({ type: 'result', name: toolCall.function.name, result: toolResult, toolId });
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }

    response = await client.chat.completions.create({
      model: selectedModel || 'qwen3:latest',
      messages,
      tools,
      tool_choice: 'auto'
    });
    assistantMessage = response.choices[0].message;
  }

  const finalText = assistantMessage.content || '';

  // Extraer bloque <think>...</think> si el modelo lo incluye (qwen3, deepseek-r1, etc.)
  let thinkContent = '';
  let cleanContent = finalText;
  const thinkMatch = finalText.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    thinkContent = thinkMatch[1].trim();
    cleanContent = finalText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  // Guardar historial COMPLETO incluyendo tool calls (sin bloques <think> para no contaminar)
  // Reemplazar la última respuesta del asistente con la versión limpia (sin <think>)
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'assistant' && cleanContent !== finalText) {
    messages[messages.length - 1] = { ...lastMsg, content: cleanContent };
  }
  const fullHistory = messages.slice(1); // omitir system prompt
  if (fullHistory.length > 80) fullHistory.splice(0, fullHistory.length - 80);
  chatHistories.set(sessionId, fullHistory);
  saveHistories();

  return { content: cleanContent, thinking: thinkContent };
}

// ─── SISTEMA DE CONFIRMACIÓN ──────────────────────────────────────────────────
const pendingConfirmations = new Map();

async function waitForConfirmation(sessionId, toolName, args, onToolCall, toolId) {
  return new Promise((resolve) => {
    const confirmId = `${sessionId}_${Date.now()}`;
    pendingConfirmations.set(confirmId, resolve);
    onToolCall && onToolCall({
      type: 'needs_confirmation',
      confirmId,
      toolId,  // para vincular la tarjeta con el resultado posterior
      name: toolName,
      args
    });
    // Timeout de 60s si no confirma
    setTimeout(() => {
      if (pendingConfirmations.has(confirmId)) {
        pendingConfirmations.delete(confirmId);
        resolve('Usuario no confirmó la ejecución (timeout).');
      }
    }, 60000);
  });
}

function confirmToolExecution(confirmId) {
  const resolve = pendingConfirmations.get(confirmId);
  if (resolve) {
    pendingConfirmations.delete(confirmId);
    return true;
  }
  return false;
}

async function executeConfirmedTool(confirmId, toolName, args) {
  const resolve = pendingConfirmations.get(confirmId);
  if (!resolve) return false;
  
  // Try to find the apiKey for this session
  const sessionId = confirmId.split('_')[0];
  const apiKey = sessionApiKeys.get(sessionId);
  
  pendingConfirmations.delete(confirmId);
  const result = await runTool(toolName, args, null, apiKey);
  resolve(result);
  return true;
}

function cancelToolExecution(confirmId) {
  const resolve = pendingConfirmations.get(confirmId);
  if (!resolve) return false;
  pendingConfirmations.delete(confirmId);
  resolve('El usuario canceló la ejecución del comando.');
  return true;
}

// ─── API PRINCIPAL ─────────────────────────────────────────────────────────────
async function chat({ provider, apiKey, model, message, sessionId, autoExecute = false, activeSkillId = null, onToolCall }) {
  sessionApiKeys.set(sessionId, apiKey); // Update saved key
  if (provider === 'gemini') {
    return chatWithGemini(apiKey, model, message, sessionId, autoExecute, onToolCall, activeSkillId);
  } else if (provider === 'deepseek') {
    return chatWithDeepSeek(apiKey, model, message, sessionId, autoExecute, onToolCall, activeSkillId);
  } else if (provider === 'ollama') {
    return chatWithOllama(model, message, sessionId, autoExecute, onToolCall, activeSkillId);
  }
  throw new Error(`Proveedor desconocido: ${provider}`);
}

function clearHistory(sessionId) {
  chatHistories.delete(sessionId);
  saveHistories(); // Persiste la eliminación en disco
}

function getSystemPrompt(activeSkillId = null) {
  const os = require('os');
  let prompt = `Sos moshiClaw, un agente de IA autónomo y avanzado integrado en un Panel de Control.
TU CARACTERÍSTICA PRINCIPAL es que tenés ACCESO REAL Y TOTAL (SUDO) al sistema Linux del usuario (Ubuntu) a través de tus herramientas (tools).

⚠️ REGLA DE ORO: No sos un "modelo de lenguaje de texto". Sos una terminal inteligente.
Si el usuario te pide "apt update", "creá una carpeta", "borrá X", NO respondas que no tenés acceso. 
Llamá INMEDIATAMENTE a la herramienta execute_command o write_file según corresponda.

Especificaciones del entorno:
Sistema: Ubuntu Linux. Hostname: ${os.hostname()}. Home: ${os.homedir()}.
Ubicación del panel: /home/moshi/moshiClaw-panel/

══════════════════════════════════════════════════
MODO AGENTE — COMPORTAMIENTO PARA TAREAS COMPLEJAS
══════════════════════════════════════════════════

Cuando el usuario te pide construir algo (un proyecto, una app, un sistema, un script, etc.), seguí SIEMPRE este flujo:

1. ANUNCIÁ EL PLAN con step_update:
   Antes de hacer CUALQUIER cosa, llamá step_update con un resumen del plan completo.
   Ejemplo: "📋 Plan: Voy a crear una app Node.js con Express. Pasos: 1) Crear carpeta, 2) Inicializar proyecto, 3) Instalar dependencias, 4) Crear archivos, 5) Probarlo."

2. EJECUTÁ PASO A PASO anunciando cada uno con step_update:
   Llamá step_update ANTES de cada paso. Ejemplo: "📁 Paso 1/5: Creando estructura de carpetas..."
   Luego ejecutá el paso. Luego el siguiente step_update, etc.
   REGLA CRÍTICA: Nunca hagas más de 2 herramientas (execute_command, write_file, read_file) seguidas sin llamar step_update entre ellas.
   Si estás creando varios archivos seguidos, avisá antes de cada grupo: "📝 Creando archivos del frontend (index.html, style.css, app.js)..."

3. USÁ write_file PARA CREAR ARCHIVOS — NUNCA heredocs en bash:
   ✅ CORRECTO: write_file({ path: '/home/moshi/proyecto/index.js', content: '...' })
   ❌ INCORRECTO: execute_command("cat > index.js << 'EOF'\n...\nEOF")
   Los heredocs en bash fallan con caracteres especiales y bloquean el proceso.
   write_file es instantáneo, confiable, y crea el directorio padre automáticamente.

4. COMANDOS BASH: uno solo a la vez, cortos y enfocados:
   ✅ CORRECTO: execute_command("cd /home/moshi/proyecto && npm install express")
   ❌ INCORRECTO: execute_command("mkdir p && cd p && npm init -y && npm install ... && cat > ... && node ...")
   Los comandos encadenados enormes se bloquean, fallan silenciosamente y son imposibles de debuggear.
   Hacé una sola cosa por vez.

5. SIEMPRE usá flags no-interactivos en bash:
   - apt: sudo apt install -y paquete
   - npm init: npm init -y
   - cp/mkdir: mkdir -p, cp -r
   Nunca uses comandos que esperen input del usuario (el proceso se cuelga indefinidamente).

6. VERIFICÁ el resultado de cada paso antes de continuar:
   Si execute_command devuelve un error, analizalo y corregilo antes de seguir.
   Reportá el error al usuario con step_update.

7. FINALIZÁ con un resumen:
   Al terminar, llamá step_update con: "✅ Tarea completada. [Resumen de lo que se hizo]"
   Luego respondé normalmente al usuario explicando qué se creó y cómo usarlo.

══════════════════════════════════
GUÍA RÁPIDA DE HERRAMIENTAS
══════════════════════════════════

step_update(message)     → Mensaje de progreso visible al usuario. USARLO SIEMPRE en tareas de más de 1 paso.
write_file(path,content) → Crear/sobreescribir archivos. PREFERIR SIEMPRE sobre heredocs bash.
execute_command(cmd)     → Comandos bash. Uno por vez. Sin interactividad. Timeout: 2 min.
read_file(path)          → Leer archivo del sistema.
generate_image(prompt)   → Generar imágenes con Gemini. OBLIGATORIO cuando el usuario pide imágenes.
browser_navigate(url)    → Navegar en browser headless.
browser_get_content()    → Leer contenido de la página actual.
browser_screenshot()     → Captura de pantalla del browser.
browser_click(selector)  → Hacer clic en la página.
browser_scroll(dir,amt)  → Desplazar la página.
open_in_brave(url)       → Abrir URL en el Brave REAL del usuario (no headless).
play_media(source,type)  → Reproducir audio/video con mpv.
stop_media()             → Detener reproducción.
messaging_status()       → Estado de WhatsApp/Messenger.
messaging_get_chats(p)   → Listar chats de WhatsApp o Messenger.
messaging_send(p,to,msg) → Enviar mensaje por WhatsApp o Messenger.

══════════════════════════════════
REGLAS SIEMPRE VIGENTES
══════════════════════════════════

- IMÁGENES: Cuando el usuario pida imágenes, fotos, arte, logos → usá generate_image OBLIGATORIAMENTE. Nunca Python ni bash para esto.
- MENSAJERÍA: Para Messenger, SIEMPRE listá chats con messaging_get_chats antes de enviar. Nunca adivines URLs.
- BRAVE: Para "abrir Brave", "buscar en Brave" → open_in_brave. Para YouTube: open_in_brave("https://www.youtube.com/results?search_query=BUSQUEDA")
- BÚSQUEDA WEB (headless): browser_navigate("https://html.duckduckgo.com/html/?q=BUSQUEDA") → browser_get_content()
- SUDO: Usá sudo para instalar paquetes, modificar sistema, gestionar servicios.
- IDIOMA: Respondé en el mismo idioma del usuario (español o inglés).

══════════════════════════════════
ESTILO DE RESPUESTA
══════════════════════════════════

CONCISIÓN — Tu regla base:
- Respondé de forma directa y breve. Si la respuesta cabe en 2 oraciones, usá 2 oraciones.
- No rellenes con frases de introducción ("Claro, con gusto...", "Por supuesto, te explico...").
- No hagas resúmenes al final si ya dijiste todo arriba.
- Solo desarrollá en detalle cuando el usuario pida explícitamente: "explicame", "desarrollá", "pensá más en esto", "dame un análisis completo", o similar.

EMOJIS — Usalos con moderación:
- En step_update está bien usarlos para marcar progreso (✅, 📁, ⚠️).
- En las respuestas de chat: evitalos salvo que el usuario los use o el contexto sea claramente informal/festivo.
- Nunca los uses como decoración vacía al inicio de cada párrafo o ítem de lista.

══════════════════════════════════
MODO JARVIS (VOZ)
══════════════════════════════════

Cuando el usuario habla por micrófono, tus respuestas son leídas en voz alta (TTS).
En ese modo: respuestas MUY cortas (1-2 oraciones máximo). Sin markdown, sin listas.
Solo para tareas técnicas respondé con contenido largo.`;

  // ── Skills: catálogo on-demand (la IA decide cuándo leer cada skill) ─────
  try {
    const skillsModule = require('./skills');
    const catalog = skillsModule.listSkills();

    if (catalog.length > 0) {
      const catalogList = catalog.map(s =>
        `  • ${s.id} — ${s.icon} ${s.name}: ${s.description}`
      ).join('\n');

      const preselectedHint = activeSkillId
        ? `\n\n\u2b50 El usuario pre-seleccion\u00f3 el skill "${activeSkillId}". Le\u00e9lo con read_skill("${activeSkillId}") antes de responder a su primer mensaje.`
        : '';

      prompt += `

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
\u26a1 SKILLS DISPONIBLES
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Ten\u00e9s acceso a skills con conocimiento experto que NO ten\u00e9s por defecto.
Cuando el pedido del usuario coincida con alguno, us\u00e1 read_skill(id) ANTES de responder.

${catalogList}

Reglas:
- Tema coincide con un skill \u2192 llam\u00e1 read_skill(id) PRIMERO, luego respond\u00e9 aplicando esas instrucciones
- Pods usar m\u00faltiples skills en la misma sesi\u00f3n si el tema cambia
- Sin skill relevante \u2192 respond\u00e9 normalmente sin llamar read_skill${preselectedHint}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`;
    }
  } catch (e) {
    // Sin skills disponibles, continuar sin catálogo
  }

  return prompt;
}

module.exports = { chat, clearHistory, executeConfirmedTool, cancelToolExecution, abortChat, PROVIDERS };
