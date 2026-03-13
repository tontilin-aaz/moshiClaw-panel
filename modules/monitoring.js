// modules/monitoring.js — Monitoreo de hardware en tiempo real
const si = require('systeminformation');

// Historial para gráficos (últimos 60 puntos)
const HISTORY_SIZE = 60;
const cpuHistory = [];
const ramHistory = [];

async function getStats() {
  try {
    const [cpu, mem, disks, temp, network, os] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature().catch(() => ({ main: null })),
      si.networkStats().catch(() => []),
      si.osInfo().catch(() => ({}))
    ]);

    const cpuUsage = Math.round(cpu.currentLoad);
    const ramUsed = Math.round((mem.used / mem.total) * 100);

    // Guardar historial
    cpuHistory.push(cpuUsage);
    ramHistory.push(ramUsed);
    if (cpuHistory.length > HISTORY_SIZE) cpuHistory.shift();
    if (ramHistory.length > HISTORY_SIZE) ramHistory.shift();

    // Formatear discos
    const diskInfo = disks.slice(0, 3).map(d => ({
      mount: d.mount,
      fs: d.fs,
      total: formatBytes(d.size),
      used: formatBytes(d.used),
      free: formatBytes(d.available),
      percent: Math.round((d.used / d.size) * 100)
    }));

    // Red (primer adaptador activo)
    const netIface = network.find(n => n.rx_sec > 0 || n.tx_sec > 0) || network[0] || {};

    return {
      cpu: {
        usage: cpuUsage,
        temp: temp.main ? Math.round(temp.main) : null,
        cores: cpu.cpus ? cpu.cpus.length : null,
        history: [...cpuHistory]
      },
      ram: {
        percent: ramUsed,
        used: formatBytes(mem.used),
        total: formatBytes(mem.total),
        free: formatBytes(mem.free),
        history: [...ramHistory]
      },
      disks: diskInfo,
      network: {
        iface: netIface.iface || '—',
        rx: formatBytes(netIface.rx_sec || 0) + '/s',
        tx: formatBytes(netIface.tx_sec || 0) + '/s'
      },
      os: {
        platform: os.platform || 'linux',
        distro: os.distro || 'Ubuntu',
        release: os.release || '',
        hostname: os.hostname || ''
      },
      timestamp: Date.now()
    };
  } catch (err) {
    console.error('Error monitoring:', err.message);
    return null;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function getProcesses() {
  try {
    const procs = await si.processes();
    return procs.list
      .sort((a, b) => b.pcpu - a.pcpu)
      .slice(0, 15)
      .map(p => ({
        pid: p.pid,
        name: p.name,
        cpu: p.pcpu,
        mem: p.pmem,
        memRss: formatBytes(p.mem_rss * 1024)
      }));
  } catch (err) {
    return [];
  }
}

module.exports = { getStats, getProcesses };
