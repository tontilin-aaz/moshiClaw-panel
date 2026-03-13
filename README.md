# 🦅 moshiClaw Panel

Panel de control remoto y avanzado para tu PC Ubuntu. Accede desde el navegador o como PWA instalada en iOS, de forma completamente segura usando Tailscale.

## ✨ Características Principales

- **📊 Monitor del Sistema** — CPU, RAM, disco, temperatura y actividad de red en tiempo real mediante gráficos dinámicos.
- **📁 Gestor de Archivos** — Navega, sube, descarga, renombra y elimina archivos remotos de tu PC visualmente.
- **📷 Webcam Stream** — Captura de imágenes instantáneas de la cámara conectada a tu PC de forma remota.
- **💻 Terminal Integrada** — Shell completo en el navegador (xterm.js + node-pty) con las mismas capacidades de un emulador de terminal nativo.
- **🖥️ Escritorio Remoto** — Streaming de pantalla en tiempo real (X11 vía ffmpeg) integrado en la web con soporte de teclado y mouse.
- **🤖 Asistente IA (Gemini/DeepSeek)** — Un chat potenciado por IA capaz de ejecutar comandos de forma autónoma en tu PC si se lo permites.
- **🔔 Notificaciones Push** — Alertas instantáneas en tu dispositivo si la CPU o RAM de tu PC superan límites críticos.

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
> Al primer arranque, el servidor genera una **contraseña aleatoria** (guardada en el `.env`) que deberás usar en la pantalla de Log In. 

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

Dentro de la PWA, toca el ícono de engranaje (⚙️) y configura el proveedor que desees usar:

| Proveedor | Obtener API Key |
|-----------|-----------------|
| **Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **DeepSeek**| [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |

> [!IMPORTANT]
> **Privacidad Local:** Las API keys se guardan exclusivamente en el almacenamiento local (`localStorage`) de tu navegador de móvil. **Nunca viajan ni se guardan en el servidor `moshiClaw`.**

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
