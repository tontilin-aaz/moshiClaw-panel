const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../data/history.json');

// Memory buffer
let history = [];
const MAX_HISTORY = 144; // 24 hours if sampled every 10 mins (actually let's do more frequent for reports)

function init(monitoring) {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            history = [];
        }
    }

    // Capture every 5 minutes
    setInterval(async () => {
        const stats = await monitoring.getStats();
        if (stats) {
            history.push({
                time: Date.now(),
                cpu: stats.cpu.usage,
                ram: stats.ram.percent
            });
            
            if (history.length > MAX_HISTORY) history.shift();
            
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
        }
    }, 1000 * 60 * 5); // 5 min
}

function getHistory() {
    return history;
}

module.exports = { init, getHistory };
