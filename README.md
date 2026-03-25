# 🦅 moshiClaw Panel

Panel de control remoto y avanzado para tu PC Ubuntu. Accede desde el navegador o como PWA instalada en iOS, de forma completamente segura usando Tailscale.

## ✨ Características Principales

- **📊 Monitor del Sistema** — CPU, RAM, disco, temperatura y actividad de red en tiempo real mediante gráficos dinámicos.
- **📈 Historial de Salud (24h)** — Gráficos históricos que muestran la evolución del uso de recursos durante el último día.
- **⚙️ Gestor de Procesos** — Visualiza, filtra y finaliza (kill) procesos del sistema directamente desde el panel.
- **📁 Gestor de Archivos** — Navega, sube, descarga, renombra y elimina archivos remotos de tu PC visualmente.
- **📷 Webcam Stream** — Captura de imágenes instantáneas de la cámara conectada a tu PC de forma remota.
- **🌐 Navegador Automatizado** — Un motor de navegación basado en Puppeteer que permite a la IA interactuar con la web de forma autónoma.
- **💻 Terminal Integrada** — Shell completo en el navegador (xterm.js + node-pty) con capacidades multitab y soporte de teclado móvil ampliado.
- **🖥️ Escritorio Remoto** — Streaming de pantalla en tiempo real (X11 vía ffmpeg) con control de mouse y teclado.
- **🤖 Agente IA Autónomo** — Chat multi-modelo (Gemini 2.5, DeepSeek, Ollama local) con modo agente completo: ejecuta comandos bash, crea archivos directamente, navega la web, genera imágenes y muestra el progreso paso a paso en tiempo real. Soporta **cancelación de emergencia** (abort signals) si la IA entra en bucles infinitos. El historial se persiste en disco.
- **💬 Mensajería Integrada** — Conexión con WhatsApp (QR / pairing code) y Messenger vía Puppeteer. Envío y recepción de mensajes directamente desde el panel.
- **🔁 Auto-Responder IA** — Responde mensajes de WhatsApp y Messenger automáticamente usando la IA. Tres modos: OFF, SEMI (aprobación manual) y AUTO. Configurable por plataforma y contacto.
- **🛡️ Claude Code & Multi-Agentes** — Integración experimental de Claude Code que permite gestionar múltiples agentes simultáneos en diferentes directorios con notificaciones de estado.
- **🌗 Temas Dinámicos** — Soporte nativo para modo Claro y Oscuro con una interfaz premium inspirada en glassmorphism.
- 🔔 **Notificaciones Push** — Alertas instantáneas si la CPU o RAM superan límites críticos o si un agente IA termina una tarea.
- ⚡ **Máximo Rendimiento y Mantenibilidad** — Arquitectura altamente modular (Refactor 2026-03) con frontend separado en micro-módulos asíncronos (`public/js/`) y backend con registro centralizado de herramientas (`modules/tools/`). Carga instantánea y código desacoplado.

---

## 📋 Requisitos Previos

- Ubuntu 20.04+ (o derivadas de Debian)
- Node.js 18+ y Python 3
- Sesión X11 activa (para la captura de pantalla nativa)
- **Tailscale** instalado y autenticado (para acceso seguro desde el exterior).

---

## 🚀 Instalación Rápida

1. Clona o descarga el repositorio y entra a la carpeta del proyecto.
2. Ejecuta el script de instalación automática:

   ```bash
   chmod +x setup.sh && ./setup.sh
   ```

3. Inicia la aplicación:

   ```bash
   ./start.sh
   ```

> [!NOTE]
> Al primer arranque, el servidor genera una **contraseña aleatoria** (guardada en el `.env`) que deberás usar en la pantalla de Log In. Si necesitas forzar una limpieza de caché en la PWA, el botón de **"Limpiar Caché"** en el login te ayudará a ver las últimas novedades.

---

## 🌐 Acceso Remoto Seguro con Tailscale (¡Sin Ngrok!)

En lugar de exponer tu PC en internet usando Ngrok (o abrir puertos en tu router), recomendamos usar **Tailscale**. Esto crea una red local cifrada (Tailnet) que te permite acceder de manera instantánea o usar una URL pública si lo prefieres, todo ello cifrado y autenticado.

### Opción 1: Usando la IP Privada del Tailnet (Más seguro)

1. En tu servidor (PC), asegúrate de que Tailscale esté ejecutándose: `tailscale status`.
2. Tu PC tendrá una IP privada de Tailscale (ej. `100.x.x.x`).
3. Instala la app de Tailscale en tu iPhone/dispositivo exterior y actívala.
4. En el navegador del dispositivo móvil, entra a `https://100.x.x.x:3000` (acepta el aviso de certificado autofirmado en el navegador móvil).

### Opción 2: Usar Tailscale Funnel / HTTPS (Recomendado para la PWA)

Para tener un certificado SSL válido automático y evitar avisos del navegador, puedes usar **Tailscale Serve/Funnel**. Sigue este paso a paso para publicarlo a tu URL pública del Tailnet:

1. **Asegúrate de tener HTTPS habilitado en Tailscale**: 
   En el panel de administración web de Tailscale, ve a "DNS". En la sección "HTTPS Certificates", asegúrate de que los certificados automáticos de Let's Encrypt estén **Activados**.

2. **Habilitar acceso externo si se requiere (Funnel / Access Controls)**:
   Si quieres acceder desde dispositivos que NO tienen Tailscale instalado, necesitas que esta URL sea realmente pública:
   En el panel web, ve a "Access Controls". Asegúrate de tener las reglas que permiten `autogroup:internet` al puerto 443 en la sección `nodeAttrs`.
   *Si solo te interesa usarlo desde clientes con Tailscale, puedes obviar este paso e ir al paso 3 (usar URL de MagicDNS sin Funnel).*

3. **Verificar tu MagicDNS**:
   Averigua el nombre completo de tu equipo dentro del Tailnet ejecutando:
   ```bash
   tailscale status
   ```
   Tu nombre puede ser algo estilo `servidor.tailnet-1234.ts.net`.

4. **Levantar el servicio de proxy reverso con Serve o Funnel**:
   Para configurar Tailscale como proxy inverso al puerto de tu panel. En tu servidor Ubuntu (PC), ejecuta:

   *(Si lo usarás con dispositivos sin Tailscale instalados):*
   ```bash
   tailscale funnel 3000
   ```
   
   *(Si lo usarás exclusivamente dispositivos que tengan la app Tailscale encendida):*
   ```bash
   tailscale serve 3000
   ```

5. **Verificar que funciona**:
   Tailscale te devolverá una URL válida como `https://equipolocal.tunombredetailscale.ts.net/`.
   Abre esa URL desde tu móvil, verifica que la web carga perfectamente y que el candado de seguridad (SSL) es válido.

---

## 📱 Instalar como App Nativa (PWA en iOS/Android)

Usando la URL HTTPS que te brindó Tailscale (ya sea Funnel o Serve):
1. Abre la URL en **Safari** en tu iPhone.
2. Toca el botón de compartir (cuadrado con flecha hacia arriba).
3. Selecciona **"Agregar a pantalla de inicio"**.
4. Ahora tendrás `moshiClaw` como una aplicación independiente con pantalla completa y persistencia.

---

## ⚙️ Configurar Inteligencia Artificial

Dentro de la PWA, toca el ícono de engranaje (⚙️) para configurar:

- **Proveedor:** Elige entre **Gemini (Google)** o **DeepSeek**.
- **Modelo:** Soporte nativo para `gemini-2.0-flash`, `deepseek-reasoner` (R1) y más.
- **Auto-ejecutar:** Habilita esta opción para que la IA realice acciones (bash, navegación) sin pedir confirmación previa.

| Proveedor | Obtener API Key |
|-----------|-----------------|
| **Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **DeepSeek**| [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |

> [!IMPORTANT]
> **Privacidad Local:** Las API keys se guardan exclusivamente en el almacenamiento local (`localStorage`) de tu navegador de móvil. **Nunca viajan ni se guardan en el servidor `moshiClaw`.** Además, el panel soporta la generación de imágenes mediante la herramienta `generate_image` integrada.

---

## ⚡ Sistema de Skills

moshiClaw soporta un sistema de **skills** compatible con el estándar SKILL.md (el mismo que usan Claude Code, OpenCode, Cursor y Gemini CLI). Cada skill es un paquete de conocimiento experto que la IA lee bajo demanda cuando el tema del pedido coincide.

- **On-demand**: la IA decide cuándo necesita un skill y lo lee automáticamente con `read_skill`. No se pre-inyectan en el prompt para no desperdiciar contexto.
- **Formato estándar**: cada skill es una carpeta con un `SKILL.md` (frontmatter YAML + cuerpo markdown). Scripts Python u otros recursos van en subcarpetas dentro de la misma carpeta del skill.
- **Pre-selección manual**: el botón ⚡ en el panel abre el gestor de skills donde podés activar uno como "sugerido" para la sesión actual.
- **Instalación desde GitHub**: pegá la URL de cualquier repositorio de skills y moshiClaw lo clona, extrae todos los SKILL.md, parchea las rutas absolutas y los registra automáticamente.

```bash
# Estructura de un skill local
data/skills/
  mi-skill/
    SKILL.md          # frontmatter + instrucciones
    scripts/
      search.py       # scripts auxiliares (opcional)
```

Los skills se gestionan desde el panel (⚡) o directamente en `data/skills/`.

---

## 🎨 Conectar Canva

moshiClaw incluye integración nativa con **Canva** para que la IA pueda crear, listar y exportar diseños directamente desde el chat.

### Cómo conectar tu cuenta

1. En el panel, abrí el menú **☰** y tocá **Canva**.
2. Hacé click en **🎨 Conectar cuenta de Canva**.
3. Se abre una ventana de login de Canva — iniciá sesión con tu cuenta.
4. Autorizá los permisos que moshiClaw solicita (leer y crear diseños).
5. La ventana se cierra sola y el panel queda conectado. ✅

Una vez conectado, podés pedirle a la IA cosas como:
- *"Creame un poster de bienvenida en Canva"*
- *"Listá mis diseños de Canva"*
- *"Exportá el diseño DAxxxxxx a PDF"*

### ❓ No me abre la ventana / da error

**Causa más común: el panel no corre en `localhost:3000`.**

La integración de Canva tiene la redirect URI fija en `http://localhost:3000/auth/canva/callback`. Si tu panel usa un puerto diferente (ej: 8080) o accedés desde una URL externa (Tailscale, ngrok), el login va a fallar porque Canva rechaza redirect URIs no registradas.

**Soluciones:**

| Situación | Solución |
|-----------|----------|
| Usás un puerto distinto al 3000 | Agregá `CANVA_REDIRECT_URI=http://localhost:TU_PUERTO/auth/canva/callback` en tu `.env` |
| Accedés desde Tailscale/ngrok | Abrí el panel en `http://localhost:3000` en la **misma PC** donde corre el servidor para hacer el login inicial. El token queda guardado y después podés usar el panel desde cualquier URL. |
| La ventana se abre pero queda en blanco | Asegurate de tener Node.js 18+ (`node --version`). |
| Error "invalid_client" | La app de Canva puede estar en modo de revisión. Contactá al desarrollador de moshiClaw. |

> [!TIP]
> El token se guarda en `data/canva_token.json` y se renueva automáticamente. Solo necesitás hacer el login **una vez**. Si desconectás la cuenta y querés reconectar, repetí el proceso desde el panel.

---

## 🤖 Claude Code y Multi-Agentes (Experimental)

moshiClaw incluye una interfaz avanzada para ejecutar **Claude Code** en múltiples directorios de forma persistente:

- **Múltiples Sesiones:** Abre diferentes agentes en carpetas específicas de tu proyecto.
- **Detección de Estado:** El panel detecta automáticamente cuando un agente está trabajando, esperando confirmación o ha terminado.
- **Notificaciones Nativas:** Recibe una notificación en tu móvil cuando un agente requiere tu atención (usa `y/n`) o completa una tarea en segundo plano.
- **Persistencia:** Las sesiones de los agentes se mantienen activas incluso si cierras la pestaña, permitiendo retomar el trabajo más tarde.

> [!TIP]
> Para activar esta sección, ve a **Configuración (⚙️)** y habilita la opción **"Claude Code en navbar"**. Asegúrate de tener `npx` disponible en tu servidor.

---

## 🔒 Seguridad del Panel

- Todo el proceso corre bajo autenticación JWT con expiraciones configurables.
- Contraseña autogenerada y guardada localmente en tu servidor.
- Por defecto, Ngrok o puertos abiertos se pueden deprimir en favor de emplear Tailscale para acceso cifrado extremo a extremo.
- Límite de intentos (Rate Limiting) previene ataques de fuerza bruta.
- El chat IA puede configurarse para requerir tu confirmación expresa (sí/no) antes de enviar comandos de bash (`sudo`, apagados, etc.) al sistema operativo.

---

## 🛠️ Entorno de Producción en el Servidor (PM2)

Para asegurarnos de que la aplicación corra en *background* al inicio de forma persistente.

```bash
# Iniciar a través del manejador de procesos
pm2 start server.js --name moshiClaw-panel

# Generar script de arranque nativo de Systemd/Ubuntu
pm2 startup

# Guardar estado para el próximo reinicio
pm2 save
```
