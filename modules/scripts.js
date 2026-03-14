const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SCRIPTS_FILE = path.join(__dirname, '../data/scripts.json');

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, '../data'))) {
    fs.mkdirSync(path.join(__dirname, '../data'));
}

// Load scripts
function getScripts() {
    if (!fs.existsSync(SCRIPTS_FILE)) {
        // Default scripts
        const defaults = [
            { id: 1, name: 'Limpiar Logs', cmd: 'rm -rf /var/log/*.log 2>/dev/null || true' },
            { id: 2, name: 'Actualizar Sistema', cmd: 'sudo apt update && sudo apt upgrade -y' },
            { id: 3, name: 'Reiniciar Servidor', cmd: 'npm run start' }
        ];
        fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
}

function saveScripts(scripts) {
    fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2));
}

function runScript(id) {
    const scripts = getScripts();
    const script = scripts.find(s => s.id === parseInt(id));
    if (!script) throw new Error('Script no encontrado');

    return new Promise((resolve) => {
        exec(script.cmd, (err, stdout, stderr) => {
            resolve({
                success: !err,
                output: stdout + stderr,
                exitCode: err ? err.code : 0
            });
        });
    });
}

function addScript(name, cmd) {
    const scripts = getScripts();
    const newScript = {
        id: Date.now(),
        name,
        cmd
    };
    scripts.push(newScript);
    saveScripts(scripts);
    return newScript;
}

function deleteScript(id) {
    let scripts = getScripts();
    scripts = scripts.filter(s => s.id !== parseInt(id));
    saveScripts(scripts);
}

module.exports = { getScripts, runScript, addScript, deleteScript };
