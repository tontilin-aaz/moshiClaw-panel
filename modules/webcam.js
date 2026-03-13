const { exec } = require('child_process');
const fs = require('fs');

function takeWebcamSnapshot() {
    return new Promise((resolve, reject) => {
        const outPath = '/tmp/_webcam_snap.jpg';
        // Usar ffmpeg para capturar 1 frame de /dev/video0. Si no existe, fallará.
        const cmd = `ffmpeg -y -f video4linux2 -i /dev/video0 -vframes 1 ${outPath}`;
        
        exec(cmd, { timeout: 5000 }, (err) => {
            if (err) {
                return reject(new Error('No se pudo capturar de la webcam (/dev/video0 no disponible o en uso).'));
            }
            try {
                const b64 = fs.readFileSync(outPath).toString('base64');
                resolve(b64);
            } catch (e) {
                reject(e);
            }
        });
    });
}

module.exports = { takeWebcamSnapshot };
