const fs = require('fs');
const path = require('path');

// Security: Restrict ALL file operations to /home/moshi only. No exceptions.
const BASE_DIR = '/home/moshi';

// Helper: safely resolve path inside BASE_DIR, rejects any traversal attempt
function safeResolve(reqPath) {
    const normalized = path.normalize(reqPath || '/').replace(/^\/+/, '');
    const resolvedPath = path.resolve(BASE_DIR, normalized);
    if (!resolvedPath.startsWith(path.resolve(BASE_DIR))) {
        throw new Error('Access denied: Cannot access paths outside of /home/moshi.');
    }
    return resolvedPath;
}

// Returns path relative to BASE_DIR for display in the frontend
function toRelPath(absolutePath) {
    return absolutePath.replace(BASE_DIR, '') || '/';
}

async function listFiles(dirPath) {
    const target = safeResolve(dirPath);
    const stats = await fs.promises.stat(target);

    if (!stats.isDirectory()) {
        throw new Error('Not a directory');
    }

    const items = await fs.promises.readdir(target, { withFileTypes: true });

    return items
        // Filter out hidden files/folders (dotfiles like .config, .git, etc.)
        .filter(item => !item.name.startsWith('.'))
        .map(item => {
            let size = 0;
            if (item.isFile()) {
                try { size = fs.statSync(path.join(target, item.name)).size; } catch {}
            }
            return {
                name: item.name,
                isDirectory: item.isDirectory(),
                size,
                path: toRelPath(path.join(target, item.name))
            };
        })
        .sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
}

function getDownloadPath(filePath) {
    return safeResolve(filePath);
}

async function renameFile(oldPath, newName) {
    const oldTarget = safeResolve(oldPath);
    const newTarget = path.join(path.dirname(oldTarget), newName);
    if (!newTarget.startsWith(path.resolve(BASE_DIR))) {
        throw new Error('Access denied.');
    }
    await fs.promises.rename(oldTarget, newTarget);
}

async function deleteFileOrFolder(targetPath) {
    const target = safeResolve(targetPath);
    const stats = await fs.promises.stat(target);
    if (stats.isDirectory()) {
        await fs.promises.rm(target, { recursive: true, force: true });
    } else {
        await fs.promises.unlink(target);
    }
}

module.exports = { listFiles, getDownloadPath, renameFile, deleteFileOrFolder };
