console.log('[INIT] threat-map.js loaded');
const socket = io();
const map = L.map('map', { center: [20, 0], zoom: 2, minZoom: 2, maxZoom: 6, worldCopyJump: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap', maxZoom: 19
}).addTo(map);
console.log('[MAP] Initialized, size:', map.getSize());

const markers = new Map();
const markersMap = new Map();

// ===================================================
// FITUR 1: GARIS SERANGAN (ANIMASI)
// ===================================================
const SERVER_LOCATION = [-6.2088, 106.8456]; // Jakarta, Indonesia

// Marker server (titik tetap)
L.marker(SERVER_LOCATION, {
  icon: L.divIcon({
    className: '',
    html: '<div style="width:18px;height:18px;border-radius:50%;background:#00d9a3;border:3px solid #fff;box-shadow:0 0 15px #00d9a3, 0 0 30px #00d9a3;"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  })
}).addTo(map).bindPopup('<div style="color:#111;font-family:sans-serif;"><b>🖥️ Server Anda</b><br>Jakarta, Indonesia</div>');

const attackLines = new Map();
let linesEnabled = true;

function drawAttackLine(attack) {
  if (!linesEnabled) return;
  if (!attack.geo || attack.geo.private) return;
  if (attack.geo.lat === null || attack.geo.lon === null) return;

  const key = attack.ip + '_' + Date.now();
  const from = [attack.geo.lat, attack.geo.lon];
  const color = getCountryColor(attack.geo.countryCode);

  // Garis utama
  const line = L.polyline([from, SERVER_LOCATION], {
    color: color,
    weight: 2,
    opacity: 0.7,
    dashArray: '10, 10'
  }).addTo(map);

  // Animasi dash (garis bergerak)
  let offset = 0;
  const interval = setInterval(() => {
    offset = (offset + 1) % 20;
    line.setStyle({ dashOffset: String(-offset) });
  }, 50);

  // Titik bergerak di sepanjang garis
  const dot = L.circleMarker(from, {
    radius: 4,
    color: color,
    fillColor: color,
    fillOpacity: 1
  }).addTo(map);

  let progress = 0;
  const dotInterval = setInterval(() => {
    progress += 0.02;
    if (progress >= 1) {
      clearInterval(dotInterval);
      setTimeout(() => { map.removeLayer(dot); }, 300);
      return;
    }
    const lat = from[0] + (SERVER_LOCATION[0] - from[0]) * progress;
    const lon = from[1] + (SERVER_LOCATION[1] - from[1]) * progress;
    dot.setLatLng([lat, lon]);
  }, 30);

  // Hapus garis setelah 15 detik
  setTimeout(() => {
    clearInterval(interval);
    clearInterval(dotInterval);
    if (map.hasLayer(line)) map.removeLayer(line);
    if (map.hasLayer(dot)) map.removeLayer(dot);
  }, 15000);
}

// ===================================================
// FITUR 2: HEATMAP
// ===================================================
let heatLayer = null;
let heatmapEnabled = false;
const heatPoints = []; // [{lat, lon, intensity}]

function initHeatmap() {
  if (typeof L.heatLayer === 'undefined') {
    console.warn('Leaflet.heat tidak dimuat');
    return;
  }
  heatLayer = L.heatLayer([], {
    radius: 25,
    blur: 20,
    maxZoom: 6,
    minOpacity: 0.4,
    gradient: {
      0.0: '#0000ff',
      0.3: '#00ff00',
      0.5: '#ffff00',
      0.7: '#ff8800',
      1.0: '#ff0000'
    }
  });
}

function addHeatPoint(attack) {
  if (!attack.geo || attack.geo.private) return;
  if (attack.geo.lat === null || attack.geo.lon === null) return;
  heatPoints.push([attack.geo.lat, attack.geo.lon, 1]);
  if (heatLayer && heatmapEnabled) {
    heatLayer.setLatLngs(heatPoints);
  }
}

function toggleHeatmap() {
  if (!heatLayer) initHeatmap();
  heatmapEnabled = !heatmapEnabled;
  const btn = document.getElementById('toggleHeatmap');
  if (heatmapEnabled) {
    heatLayer.setLatLngs(heatPoints);
    heatLayer.addTo(map);
    btn.textContent = '🔥 Heatmap: ON';
    btn.style.background = '#ff4757';
    btn.style.color = '#fff';
  } else {
    if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    btn.textContent = '🔥 Heatmap: OFF';
    btn.style.background = '#ffa502';
    btn.style.color = '#0a0e14';
  }
}

// ===================================================
// FITUR 3: STATISTIK PER NEGARA
// ===================================================
const countryStats = {}; // { code: { name, count, flag } }

function updateCountryStats(attack) {
  if (!attack.geo || attack.geo.private) return;
  const code = attack.geo.countryCode || 'XX';
  const name = attack.geo.country || 'Unknown';
  if (!countryStats[code]) {
    countryStats[code] = { name, count: 0, flag: getFlagEmoji(code) };
  }
  countryStats[code].count++;
  renderCountryStats();
}

function renderCountryStats() {
  const container = document.getElementById('countryStats');
  if (!container) return;

  const sorted = Object.entries(countryStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  if (sorted.length === 0) {
    container.innerHTML = '<p class="empty">Belum ada data</p>';
    return;
  }

  const maxCount = sorted[0][1].count;
  container.innerHTML = sorted.map(([code, data]) => {
    const percent = (data.count / maxCount) * 100;
    const color = getCountryColor(code);
    return '<div style="margin-bottom:12px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
      '<span>' + data.flag + ' ' + escapeHtml(data.name) + '</span>' +
      '<span style="color:' + color + ';font-weight:700;">' + data.count + '</span>' +
      '</div>' +
      '<div style="height:6px;background:#1f2c33;border-radius:3px;overflow:hidden;">' +
      '<div style="height:100%;width:' + percent + '%;background:' + color + ';transition:width 0.5s;"></div>' +
      '</div>' +
      '</div>';
  }).join('');

  updateCountryFilter();
}

// ===================================================
// FITUR 4: FILTER NEGARA
// ===================================================
let currentFilter = 'all';

function updateCountryFilter() {
  const select = document.getElementById('countryFilter');
  if (!select) return;

  const sorted = Object.entries(countryStats)
    .sort((a, b) => b[1].count - a[1].count);

  const currentValue = select.value;
  select.innerHTML = '<option value="all">🌐 Semua Negara (' + sorted.reduce((s, [, d]) => s + d.count, 0) + ')</option>' +
    sorted.map(([code, data]) =>
      '<option value="' + code + '">' + data.flag + ' ' + escapeHtml(data.name) + ' (' + data.count + ')</option>'
    ).join('');

  select.value = currentValue || 'all';
}

function applyFilter() {
  // Sembunyikan/tampilkan marker berdasarkan filter
  markersMap.forEach((marker, ip) => {
    const attack = recentAttacksCache.get(ip);
    if (!attack || !attack.geo) return;

    const matches = currentFilter === 'all' || attack.geo.countryCode === currentFilter;
    if (matches) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else {
      if (map.hasLayer(marker)) map.removeLayer(marker);
    }
  });
}

// Cache untuk filter
const recentAttacksCache = new Map();

// ===================================================
// WIRE UP EVENT LISTENERS
// ===================================================
setTimeout(() => {
  initHeatmap();

  const filterSelect = document.getElementById('countryFilter');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      currentFilter = e.target.value;
      applyFilter();
    });
  }

  const btnLines = document.getElementById('toggleLines');
  if (btnLines) {
    btnLines.addEventListener('click', () => {
      linesEnabled = !linesEnabled;
      btnLines.textContent = linesEnabled ? '📏 Garis: ON' : '📏 Garis: OFF';
      btnLines.style.background = linesEnabled ? '#00d9a3' : '#8696a0';
    });
  }

  const btnHeat = document.getElementById('toggleHeatmap');
  if (btnHeat) {
    btnHeat.addEventListener('click', toggleHeatmap);
  }
}, 1000);
 // IP -> marker
// Warna marker per negara
const countryColors = {
  'ID': '#ff4757',  // Indonesia - merah
  'US': '#3742fa',  // USA - biru
  'CN': '#ffa502',  // China - kuning
  'RU': '#a55eea',  // Rusia - ungu
  'DE': '#00d9a3',  // Jerman - hijau
  'AU': '#fd79a8',  // Australia - pink
  'NL': '#f39c12',  // Belanda - oranye
  'FR': '#3498db',  // Perancis - biru muda
  'GB': '#9b59b6',  // UK - ungu muda
  'IN': '#e67e22',  // India - oranye
  'BR': '#27ae60',  // Brazil - hijau tua
  'JP': '#e74c3c'   // Jepang - merah tua
};

function getCountryColor(code) {
  return countryColors[code] || '#ff4757';
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode === 'XX') return '🌐';
  try {
    return countryCode.replace(/./g, c => String.fromCodePoint(c.charCodeAt(0) + 127397));
  } catch (e) {
    return '🌐';
  }
}

function getIcon(color) {
  return L.divIcon({
    className: '',
    html: '<div style="width:20px;height:20px;border-radius:50%;background:' + color + ';border:3px solid #fff;box-shadow:0 0 0 0 ' + color + 'aa;animation:markerPulse 2s infinite;"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
}

// Icon default (fallback)
const pulseIcon = getIcon('#ff4757');
const privateIcon = L.divIcon({ className: 'custom-private-marker', iconSize: [20, 20], iconAnchor: [10, 10], html: '<div style="color:#8696a0;font-size:20px;text-align:center;">🏠</div>' });
let totalAttacks = 0, uniqueIPs = new Set(), loginAttempts = 0, startTime = Date.now();

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString('id-ID'); } catch { return '-'; }
}
function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  return Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
}
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function updateStats(data) {
  if (data.totalAttacks !== undefined) { totalAttacks = data.totalAttacks; document.getElementById('totalAttacks').textContent = totalAttacks; }
  if (data.uniqueIPs !== undefined) document.getElementById('uniqueIPs').textContent = data.uniqueIPs;
  if (data.topUsernames) renderTopList('topUsernames', data.topUsernames);
  if (data.topPasswords) renderTopList('topPasswords', data.topPasswords);
  if (data.topCommands) renderTopList('topCommands', data.topCommands);
}

function renderTopList(id, items) {
  const ul = document.getElementById(id);
  if (!items || items.length === 0) { ul.innerHTML = '<li><span class="label">-</span><span class="count">0</span></li>'; return; }
  ul.innerHTML = items.map(([label, count]) => `<li><span class="label">${escapeHtml(label)}</span><span class="count">${count}</span></li>`).join('');
}

function addAttackToFeed(attack) {
  const feed = document.getElementById('feed');
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `attack-item ${attack.type}`;
  let badge = '';
  if (attack.type === 'login_failed') badge = '<span class="attack-badge badge-failed">LOGIN GAGAL</span>';
  else if (attack.type === 'login_success') badge = '<span class="attack-badge badge-success">LOGIN BERHASIL</span>';
  else if (attack.type === 'command') badge = '<span class="attack-badge badge-command">COMMAND</span>';
  else if (attack.type === 'connect') badge = '<span class="attack-badge badge-connect">CONNECT</span>';
  let detail = '';
  if (attack.type === 'login_failed' || attack.type === 'login_success') {
    detail = `<div class="attack-detail">User: <b>${escapeHtml(attack.username||'-')}</b> | Pass: <b>${escapeHtml(attack.password||'-')}</b></div>`;
  } else if (attack.type === 'command') {
    detail = `<div class="attack-detail">$ ${escapeHtml(attack.command||'')}</div>`;
  }
  div.innerHTML = `<div class="attack-time">${formatTime(attack.time)}</div><div>${badge}<span class="attack-ip">${escapeHtml(attack.ip)}</span></div>${detail}`;
  feed.insertBefore(div, feed.firstChild);
  while (feed.children.length > 100) feed.removeChild(feed.lastChild);
}


// === MAP MARKER ===
function addMarkerToMap(attack) {
  if (!attack.geo) return;
  if (attack.geo.private) return;
  if (attack.geo.lat === null || attack.geo.lon === null) return;

  const key = attack.ip;
  const latlng = [attack.geo.lat, attack.geo.lon];
  const color = getCountryColor(attack.geo.countryCode);
  const flag = getFlagEmoji(attack.geo.countryCode);

  const popupHtml = '<div style="font-family:sans-serif;color:#111;min-width:200px;">' +
    '<div style="font-weight:700;font-size:15px;color:#00a884;margin-bottom:6px;">' + flag + ' ' + escapeHtml(attack.geo.country || '-') + ' (' + (attack.geo.countryCode || 'XX') + ')</div>' +
    '<div style="font-size:12px;margin-bottom:3px;"><b>IP:</b> <span style="font-family:monospace;">' + escapeHtml(attack.ip) + '</span></div>' +
    '<div style="font-size:12px;margin-bottom:3px;"><b>Kota:</b> ' + escapeHtml(attack.geo.city || '-') + '</div>' +
    '<div style="font-size:12px;margin-bottom:3px;"><b>ISP:</b> ' + escapeHtml(attack.geo.isp || '-') + '</div>' +
    '</div>';

  // Simpan ke cache untuk filter
  recentAttacksCache.set(key, attack);

  if (markersMap.has(key)) {
    const m = markersMap.get(key);
    m.setLatLng(latlng);
    m.setPopupContent(popupHtml);
    m.setIcon(getIcon(color));
    if (m.getElement()) {
      m.getElement().classList.add('pulse-active');
      setTimeout(() => { if (m.getElement()) m.getElement().classList.remove('pulse-active'); }, 2000);
    }
  } else {
    const marker = L.marker(latlng, { icon: getIcon(color) }).addTo(map);
    marker.bindPopup(popupHtml);
    markersMap.set(key, marker);
    if (markersMap.size === 1) marker.openPopup();
  }
}

socket.on('connect', () => { socket.emit('get threat stats'); });
socket.on('threat stats', (data) => {
  updateStats(data);
  if (data.recentAttacks) {
    const feed = document.getElementById('feed');
    feed.innerHTML = '';
    if (data.recentAttacks.length === 0) feed.innerHTML = '<div class="empty">Menunggu serangan masuk...</div>';
    else data.recentAttacks.forEach(a => { 
      addAttackToFeed(a); 
      addMarkerToMap(a); 
      addHeatPoint(a);
      updateCountryStats(a);
    });
  }
  if (data.startTime) startTime = new Date(data.startTime).getTime();
});
socket.on('cowrie-attack', (attack) => {
  addAttackToFeed(attack);
  addMarkerToMap(attack);
  if (['login_failed','login_success','command'].includes(attack.type)) {
    totalAttacks++;
    uniqueIPs.add(attack.ip);
    if (attack.type === 'login_failed') loginAttempts++;
    document.getElementById('totalAttacks').textContent = totalAttacks;
    document.getElementById('uniqueIPs').textContent = uniqueIPs.size;
    document.getElementById('loginAttempts').textContent = loginAttempts;
  }
});
setInterval(() => { document.getElementById('sessionTime').textContent = formatDuration(Date.now() - startTime); }, 60000);
socket.emit('get threat stats');
