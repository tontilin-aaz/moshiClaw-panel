// modules/ai.js — Adaptador multi-proveedor: Gemini + DeepSeek
const { executeCommand } = require('./terminal');
const browser = require('./browser');

// Proveedores disponibles
const PROVIDERS = {
  gemini: 'gemini',
  deepseek: 'deepseek'
};

// Historial de conversación por sesión
const chatHistories = new Map();
const sessionApiKeys = new Map(); // Store API key per session for tool execution

// Herramientas que la IA puede usar
const AI_TOOLS = {
  execute_command: {
    description: 'Ejecuta CUALQUIER comando bash en la PC Ubuntu. Tenés permisos de SUDO para tareas administrativas, instalaciones y control total del sistema.',
    parameters: {
      command: { type: 'string', description: 'El comando bash completo a ejecutar (usá sudo si es necesario)' }
    }
  },
  read_file: {
    description: 'Lee el contenido de cualquier archivo del sistema, incluyendo archivos protegidos si usás sudo en conjunto con herramientas de lectura.',
    parameters: {
      path: { type: 'string', description: 'Ruta absoluta del archivo' }
    }
  },
  browser_navigate: {
    description: 'Abre una URL en el navegador controlado. Usá esto para buscar en Google, abrir páginas web, etc.',
    parameters: {
      url: { type: 'string', description: 'URL completa a navegar (debe incluir https://)' }
    }
  },
  browser_get_content: {
    description: 'Obtiene el texto visible de la página actual del navegador. Usá esto para leer resultados de búsqueda, artículos, etc.',
    parameters: {}
  },
  browser_screenshot: {
    description: 'Toma una captura de pantalla del navegador y la envía al panel del usuario.',
    parameters: {}
  },
  browser_click: {
    description: 'Hace clic en un elemento de la página usando un selector CSS.',
    parameters: {
      selector: { type: 'string', description: 'Selector CSS del elemento a clickear (ej: "a.result", "#submit-btn")' }
    }
  },
  generate_image: {
    description: 'Genera una imagen a partir de una descripción de texto usando Google Imagen.',
    parameters: {
      prompt: { type: 'string', description: 'Descripción detallada de la imagen que quieres generar' }
    }
  }
};

// Ejecutar herramienta real
async function runTool(toolName, args, onToolCall, apiKey) {
  if (toolName === 'execute_command') {
    const result = await executeCommand(args.command, 60000); // 60s timeout
    return `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nCódigo de salida: ${result.exitCode}`;
  }
  if (toolName === 'read_file') {
    const fs = require('fs');
    try {
      const content = fs.readFileSync(args.path, 'utf8');
      return content.slice(0, 4000);
    } catch (e) {
      return `Error leyendo archivo: ${e.message}`;
    }
  }
  if (toolName === 'browser_navigate') {
    const res = await browser.navigate(args.url);
    // Tomar screenshot automáticamente y notificar al panel
    const img = await browser.screenshot();
    if (img && onToolCall) {
      onToolCall({ type: 'browser_screenshot', image: img });
    }
    if (res.error) return `Error navegando a ${args.url}: ${res.error}`;
    return `Navegando a: ${res.url}\nTítulo de la página: ${res.title}`;
  }
  if (toolName === 'browser_get_content') {
    return await browser.getContent();
  }
  if (toolName === 'browser_screenshot') {
    const img = await browser.screenshot();
    if (!img) return 'No se pudo tomar screenshot (navegador no iniciado).';
    if (onToolCall) onToolCall({ type: 'browser_screenshot', image: img });
    return 'Screenshot tomado y enviado al panel.';
  }
  if (toolName === 'browser_click') {
    const result = await browser.click(args.selector);
    // Screenshot post-clic
    const img = await browser.screenshot();
    if (img && onToolCall) onToolCall({ type: 'browser_screenshot', image: img });
    return result;
  }
  if (toolName === 'generate_image') {
    const fetch = require('node-fetch');
    const effectiveKey = apiKey || process.env.GEMINI_API_KEY || 'TU_API_KEY_AQUI';
    
    // IMPORTANTE: El SDK @google/genai usa el endpoint :predict para generateImages.
    // Sin embargo, gemini-2.5-flash-image en AI Studio (claves gratuitas/estándar) 
    // requiere el endpoint :generateContent. Por eso el SDK falla con 404.
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${effectiveKey}`;

    try {
      console.log("DEBUG: Usando fetch con :generateContent para gemini-2.5-flash-image...");
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: args.prompt }]
          }]
        })
      });

      const data = await response.json();
      
      if (data.error) {
          console.error("DEBUG: Error de API:", data.error);
          return `Error de la API de Google: ${data.error.message}`;
      }

      // El resultado de imagen en generateContent viene en inlineData
      if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
          const partVisible = data.candidates[0].content.parts.find(p => p.inlineData);
          if (partVisible && partVisible.inlineData) {
              const b64 = partVisible.inlineData.data;
              console.log(`DEBUG: Imagen generada con éxito (longitud b64: ${b64.length})`);
              return `![Imagen generada](data:image/jpeg;base64,${b64})`;
          }
      }

      console.error("DEBUG: Estructura no reconocida:", JSON.stringify(data).slice(0, 500));
      return `El modelo no devolvió una imagen válida. Intente con otro prompt.`;
    } catch (err) {
      console.error("DEBUG: fallo en fetch:", err.message);
      return `Error técnico al conectar con Google: ${err.message}`;
    }
  }
  return `Herramienta desconocida: ${toolName}`;
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function chatWithGemini(apiKey, selectedModel, message, sessionId, autoExecute, onToolCall) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  console.log('DEBUG: Usando modelo:', selectedModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite');
  const model = genAI.getGenerativeModel({
    model: selectedModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
    systemInstruction: getSystemPrompt(),
    tools: [{
      functionDeclarations: [
        {
          name: 'execute_command',
          description: AI_TOOLS.execute_command.description,
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Comando bash a ejecutar' }
            },
            required: ['command']
          }
        },
        {
          name: 'read_file',
          description: AI_TOOLS.read_file.description,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Ruta del archivo' }
            },
            required: ['path']
          }
        },
        {
          name: 'browser_navigate',
          description: AI_TOOLS.browser_navigate.description,
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL completa a navegar' }
            },
            required: ['url']
          }
        },
        {
          name: 'browser_get_content',
          description: AI_TOOLS.browser_get_content.description,
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'browser_screenshot',
          description: AI_TOOLS.browser_screenshot.description,
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'browser_click',
          description: AI_TOOLS.browser_click.description,
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'Selector CSS del elemento' }
            },
            required: ['selector']
          }
        },
        {
          name: 'generate_image',
          description: AI_TOOLS.generate_image.description,
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Descripción detallada' }
            },
            required: ['prompt']
          }
        }
      ]
    }]
  });

  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);

  const chat = model.startChat({ history });

  let result = await chat.sendMessage(message);
  let response = result.response;

  // Manejar function calls en loop
  let calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : [];
  while (calls && calls.length > 0) {
    const functionResponses = [];

    for (const call of calls) {
      let toolResult;
      const isAutoTool = call.name.startsWith('browser_') || call.name === 'generate_image';
      if (autoExecute || isAutoTool) {
        onToolCall && onToolCall({ type: 'executing', name: call.name, args: call.args });
        toolResult = await runTool(call.name, call.args, onToolCall, apiKey);
        onToolCall && onToolCall({ type: 'result', name: call.name, result: toolResult });
      } else {
        // Modo confirmación: pausar y esperar
        toolResult = await waitForConfirmation(sessionId, call.name, call.args, onToolCall);
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

  // Guardar historial simplificado
  history.push({ role: 'user', parts: [{ text: message }] });
  history.push({ role: 'model', parts: [{ text: response.text() }] });
  if (history.length > 40) history.splice(0, 2); // Limitar historial

  return response.text();
}

// ─── DEEPSEEK ─────────────────────────────────────────────────────────────────
async function chatWithDeepSeek(apiKey, selectedModel, message, sessionId, autoExecute, onToolCall) {
  const OpenAI = require('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com'
  });

  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...history,
    { role: 'user', content: message }
  ];

  const tools = [
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: AI_TOOLS.execute_command.description,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Comando bash a ejecutar' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: AI_TOOLS.read_file.description,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta del archivo' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: AI_TOOLS.browser_navigate.description,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL completa a navegar' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_content',
        description: AI_TOOLS.browser_get_content.description,
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: AI_TOOLS.browser_screenshot.description,
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: AI_TOOLS.browser_click.description,
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Selector CSS del elemento' }
          },
          required: ['selector']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generate_image',
        description: AI_TOOLS.generate_image.description,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Descripción detallada' }
          },
          required: ['prompt']
        }
      }
    }
  ];

  let response = await client.chat.completions.create({
    model: selectedModel || 'deepseek-chat',
    messages,
    tools,
    tool_choice: 'auto'
  });

  let assistantMessage = response.choices[0].message;

  // Loop de tool calls
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let toolResult;
      const isAutoTool = toolCall.function.name.startsWith('browser_') || toolCall.function.name === 'generate_image';

      if (autoExecute || isAutoTool) {
        onToolCall && onToolCall({ type: 'executing', name: toolCall.function.name, args });
        toolResult = await runTool(toolCall.function.name, args, onToolCall, apiKey);
        onToolCall && onToolCall({ type: 'result', name: toolCall.function.name, result: toolResult });
      } else {
        toolResult = await waitForConfirmation(sessionId, toolCall.function.name, args, onToolCall);
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

  // Actualizar historial
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: finalText });
  if (history.length > 40) history.splice(0, 2);

  return finalText;
}

// ─── SISTEMA DE CONFIRMACIÓN ──────────────────────────────────────────────────
const pendingConfirmations = new Map();

async function waitForConfirmation(sessionId, toolName, args, onToolCall) {
  return new Promise((resolve) => {
    const confirmId = `${sessionId}_${Date.now()}`;
    pendingConfirmations.set(confirmId, resolve);
    onToolCall && onToolCall({
      type: 'needs_confirmation',
      confirmId,
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
async function chat({ provider, apiKey, model, message, sessionId, autoExecute = false, onToolCall }) {
  sessionApiKeys.set(sessionId, apiKey); // Update saved key
  if (provider === 'gemini') {
    return chatWithGemini(apiKey, model, message, sessionId, autoExecute, onToolCall);
  } else if (provider === 'deepseek') {
    return chatWithDeepSeek(apiKey, model, message, sessionId, autoExecute, onToolCall);
  }
  throw new Error(`Proveedor desconocido: ${provider}`);
}

function clearHistory(sessionId) {
  chatHistories.delete(sessionId);
}

function getSystemPrompt() {
  const os = require('os');
  return `Sos moshiClaw, un asistente de IA avanzado y potente con ACCESO TOTAL (SUDO) al sistema Linux del usuario.
El sistema operativo es Ubuntu Linux. Hostname: ${os.hostname()}. Directorio home: ${os.homedir()}.

Capacidades de Máximo Nivel:
- Control total del sistema operativo mediante comandos bash (execute_command).
- Podés usar 'sudo' para cualquier tarea administrativa (instalar paquetes, modificar archivos del sistema, gestionar servicios).
- Acceso a archivos en TODO el disco, incluyendo raíz (read_file).
- Navegación web avanzada (browser_navigate) y extracción de datos.
- Automatización de tareas complejas en la PC.

Pautas de Ejecución:
- No dudes en usar los comandos necesarios para resolver el problema del usuario.
- Si necesitás permisos de root, usá 'sudo' al principio del comando.
- IMPORTANTE: Usá siempre flags no-interactivos (como -y en apt) para evitar que el comando se bloquee esperando input.
- Explicá brevemente qué vas a hacer antes de ejecutar comandos críticos.
- Cuando el usuario pida imágenes (dibujos, fotos, arte, retratos, logos, etc.), DEBES usar OBLIGATORIAMENTE la herramienta 'generate_image'. Esta herramienta usa el modelo 'gemini-2.5-flash-image'.
- NUNCA intentes generar imágenes escribiendo scripts de Python, usando comandos de terminal o fingiendo que las creaste. Usá siempre la herramienta.
- Si el usuario simplemente dice "hace una imagen de X", llamá a la herramienta directamente sin preguntar de nuevo.
- Si la herramienta 'generate_image' falla, infórmame del error exacto.
  1. Usá browser_navigate para ir a: https://html.duckduckgo.com/html/?q=TU+BUSQUEDA
  2. Usá browser_get_content para leer los resultados
  3. Respondé con la información encontrada.

IMPORTANTE: Sos el administrador del sistema. Tenés permiso para hacer TODO en la PC.
Respondé en el mismo idioma que usa el usuario (español o inglés).`;
}

module.exports = { chat, clearHistory, executeConfirmedTool, cancelToolExecution, PROVIDERS };
