const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);

// === COWRIE HONEYPOT LOG READER ===
const COWRIE_LOG = '/mnt/sdcard/cowrie/var/log/cowrie/cowrie.json';
// === GEOIP LOOKUP ===
const geoCache = new Map();

function isPrivateIP(ip) {
  if (!ip) return true;
  return ip.startsWith('127.') ||
         ip.startsWith('10.') ||
         ip.startsWith('192.168.') ||
         /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
         ip === '::1' ||
         ip.startsWith('fe80:') ||
         ip.startsWith('169.254.') ||
         ip === 'unknown';
}

const geoQueue = [];
let geoProcessing = false;

function lookupGeoIP(ip) {
  return new Promise((resolve) => {
    if (isPrivateIP(ip)) {
      return resolve({ private: true, country: 'Local Network', countryCode: 'LO', city: '-', lat: null, lon: null, isp: '-' });
    }
    if (geoCache.has(ip)) return resolve(geoCache.get(ip));
    
    // Queue untuk hindari rate limit
    geoQueue.push({ ip, resolve });
    processGeoQueue();
  });
}

function processGeoQueue() {
  if (geoProcessing || geoQueue.length === 0) return;
  geoProcessing = true;
  const { ip, resolve } = geoQueue.shift();
  geoLookupSingle(ip).then(result => {
    geoCache.set(ip, result);
    resolve(result);
    geoProcessing = false;
    // Delay 1.5 detik antar request (rate limit ip-api: 45/menit)
    setTimeout(processGeoQueue, 1500);
  }).catch(() => {
    resolve({ country: 'Unknown', lat: null, lon: null });
    geoProcessing = false;
    setTimeout(processGeoQueue, 1500);
  });
}

function geoLookupSingle(ip) {
  return new Promise((resolve) => {

    const req = http.get(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,lat,lon,isp,org,as,query`,
      { timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const geo = JSON.parse(data);
            if (geo.status === 'success') {
              const result = {
                country: geo.country,
                countryCode: geo.countryCode,
                city: geo.city,
                lat: geo.lat,
                lon: geo.lon,
                isp: geo.isp || geo.org,
                as: geo.as
              };
              geoCache.set(ip, result);
              resolve(result);
            } else {
              const fallback = { country: 'Unknown', countryCode: 'XX', city: '-', lat: null, lon: null, isp: '-' };
              geoCache.set(ip, fallback);
              resolve(fallback);
            }
          } catch (e) {
            resolve({ country: 'Unknown', countryCode: 'XX', lat: null, lon: null });
          }
        });
      }
    );
    req.on('error', () => resolve({ country: 'Unknown', lat: null, lon: null }));
    req.on('timeout', () => { req.destroy(); resolve({ country: 'Unknown', lat: null, lon: null }); });
  });
}


let cowrieLastSize = 0;
const recentAttacks = [];
const attackerStats = {
  totalAttacks: 0,
  uniqueIPs: new Set(),
  topUsernames: {},
  topPasswords: {},
  topCommands: {},
  startTime: new Date().toISOString()
};

function parseCowrieLog() {
  try {
    if (!fs.existsSync(COWRIE_LOG)) return;
    const stats = fs.statSync(COWRIE_LOG);
    if (stats.size <= cowrieLastSize) return;
    const stream = fs.createReadStream(COWRIE_LOG, { start: cowrieLastSize, encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      buffer.split('\n').filter(l => l.trim()).forEach(line => {
        try { handleCowrieEvent(JSON.parse(line)); } catch (e) {}
      });
      cowrieLastSize = stats.size;
    });
  } catch (err) { console.error('Cowrie log error:', err.message); }
}

async function handleCowrieEvent(event) {
  const srcIp = event.src_ip || 'unknown';
  const timestamp = event.timestamp || new Date().toISOString();
  let attack = null;
  
  if (event.eventid === 'cowrie.session.connect') {
    attack = { type: 'connect', ip: srcIp, port: event.src_port, time: timestamp };
  } else if (event.eventid === 'cowrie.login.failed') {
    attack = { type: 'login_failed', ip: srcIp, username: event.username || '', password: event.password || '', time: timestamp };
    attackerStats.topUsernames[event.username] = (attackerStats.topUsernames[event.username] || 0) + 1;
    attackerStats.topPasswords[event.password] = (attackerStats.topPasswords[event.password] || 0) + 1;
  } else if (event.eventid === 'cowrie.login.success') {
    attack = { type: 'login_success', ip: srcIp, username: event.username || '', password: event.password || '', time: timestamp };
  } else if (event.eventid === 'cowrie.command.input') {
    attack = { type: 'command', ip: srcIp, command: event.input || '', time: timestamp };
    attackerStats.topCommands[event.input] = (attackerStats.topCommands[event.input] || 0) + 1;
  } else if (event.eventid === 'cowrie.session.closed') {
    attack = { type: 'disconnect', ip: srcIp, time: timestamp };
  }
  
  if (attack) {
    recentAttacks.unshift(attack);
    if (recentAttacks.length > 100) recentAttacks.pop();
    if (['login_failed','login_success','command'].includes(attack.type)) {
      attackerStats.totalAttacks++;
      attackerStats.uniqueIPs.add(srcIp);
    }
    // Lookup GeoIP (async)
    lookupGeoIP(srcIp).then(geo => {
      attack.geo = geo;
      if (typeof io !== 'undefined') io.emit('cowrie-attack', attack);
    }).catch(() => {
      if (typeof io !== 'undefined') io.emit('cowrie-attack', attack);
    });
  }
}

function startCowrieWatcher() {
  console.log('[COWRIE] Watching:', COWRIE_LOG);
  if (fs.existsSync(COWRIE_LOG)) { cowrieLastSize = 0; parseCowrieLog(); }
  setInterval(parseCowrieLog, 2000);
}

function getCowrieStats() {
  return {
    totalAttacks: attackerStats.totalAttacks,
    uniqueIPs: attackerStats.uniqueIPs.size,
    topUsernames: Object.entries(attackerStats.topUsernames).sort((a,b)=>b[1]-a[1]).slice(0,5),
    topPasswords: Object.entries(attackerStats.topPasswords).sort((a,b)=>b[1]-a[1]).slice(0,5),
    topCommands: Object.entries(attackerStats.topCommands).sort((a,b)=>b[1]-a[1]).slice(0,5),
    recentAttacks: recentAttacks.slice(0, 50),
    startTime: attackerStats.startTime
  };
}
const io = new Server(server);

// ============================================
// SYSTEM MONITOR — Fungsi
// ============================================
function readSystemInfo() {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const info = { time: new Date().toLocaleTimeString('id-ID') };
  
  try {
    info.temp = (parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000).toFixed(1);
  } catch (e) { info.temp = null; }
  
  try {
    info.cpuFreq = (parseInt(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8')) / 1000).toFixed(0);
    info.cpuGov = fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim();
  } catch (e) { info.cpuFreq = null; }
  
  try {
    const mem = execSync('free -m | grep Mem').toString().split(/\s+/);
    info.ramUsed = mem[2];
    info.ramTotal = mem[1];
    info.ramPct = Math.round((mem[2] / mem[1]) * 100);
  } catch (e) { info.ramUsed = null; }
  
  try {
    info.load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  } catch (e) { info.load = null; }
  
  return info;
}

function formatSystemMsg(info) {
  let msg = '🌡️ ' + info.temp + '°C';
  if (info.cpuFreq) msg += ' · 💻 ' + info.cpuFreq + 'MHz (' + info.cpuGov + ')';
  if (info.ramUsed) msg += ' · 💾 ' + info.ramUsed + '/' + info.ramTotal + 'MB (' + info.ramPct + '%)';
  if (info.load) msg += ' · 📊 Load ' + info.load;
  return msg;
}



const DATA_DIR = '/mnt/sdcard/chat-data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db', 'chat.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = null;
let SQL = null;

async function initDb() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
 
 
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      pin TEXT NOT NULL,
      created_by TEXT NOT NULL,
      is_private INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS room_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      message TEXT,
      image_url TEXT,
      time TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      message TEXT,
      image_url TEXT,
      time TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS private_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      message TEXT,
      image_url TEXT,
      time TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getMessages(limit = 50) {
  const stmt = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?');
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.reverse();
}

function saveMessage(username, message, imageUrl, time) {
  db.run(
    'INSERT INTO messages (username, message, image_url, time) VALUES (?, ?, ?, ?)',
    [username, message, imageUrl, time]
  );
  saveDb();
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = stmt.getAsObject().id;
  stmt.free();
  return id;
}

function savePrivateMessage(fromUser, toUser, message, imageUrl, time) {
  db.run(
    'INSERT INTO private_messages (from_user, to_user, message, image_url, time) VALUES (?, ?, ?, ?, ?)',
    [fromUser, toUser, message, imageUrl, time]
  );
  saveDb();
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = stmt.getAsObject().id;
  stmt.free();
  return id;
}

function getPrivateMessages(user1, user2, limit = 50) {
  const stmt = db.prepare(`
    SELECT * FROM private_messages
    WHERE (from_user = ? AND to_user = ?)
       OR (from_user = ? AND to_user = ?)
    ORDER BY id DESC LIMIT ?
  `);
  stmt.bind([user1, user2, user2, user1, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.reverse();
}

function markPrivateAsRead(fromUser, toUser) {
  db.run(
    'UPDATE private_messages SET is_read = 1 WHERE from_user = ? AND to_user = ?',
    [fromUser, toUser]
  );
  saveDb();
}

function createRoom(name, pin, createdBy, isPrivate = 1) {
  try {
    db.run(
      'INSERT INTO rooms (name, pin, created_by, is_private) VALUES (?, ?, ?, ?)',
      [name, pin, createdBy, isPrivate]
    );
    saveDb();
    const stmt = db.prepare('SELECT last_insert_rowid() as id');
    stmt.step();
    const id = stmt.getAsObject().id;
    stmt.free();
    return { success: true, id };
  } catch (err) {
    return { success: false, error: 'Room sudah ada' };
  }
}

function getRooms() {
  const stmt = db.prepare('SELECT id, name, created_by, is_private, created_at FROM rooms ORDER BY id DESC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function verifyRoomPin(roomId, pin) {
  const stmt = db.prepare('SELECT id, name FROM rooms WHERE id = ? AND pin = ?');
  stmt.bind([roomId, pin]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function saveRoomMessage(roomId, username, message, imageUrl, time) {
  db.run(
    'INSERT INTO room_messages (room_id, username, message, image_url, time) VALUES (?, ?, ?, ?, ?)',
    [roomId, username, message, imageUrl, time]
  );
  saveDb();
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = stmt.getAsObject().id;
  stmt.free();
  return id;
}

function getRoomMessages(roomId, limit = 50) {
  const stmt = db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?');
  stmt.bind([roomId, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.reverse();
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Hanya gambar yang diizinkan'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/chat/uploads/${req.file.filename}` });
});


app.get('/api/system-info', (req, res) => {
  try {
    const info = readSystemInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages', (req, res) => {
  res.json(getMessages());
});

app.get('/api/threat-stats', (req, res) => {
  res.json(getCowrieStats());
});

app.get('/threat-map', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'threat-map.html'));
});

app.get('/chat/threat-map', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'threat-map.html'));
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.emit('history', getMessages());

  socket.on('join', (username) => {
    socket.username = username;
    onlineUsers.set(username, socket.id);
    io.emit('system', `${username} joined`);
    io.emit('online users', Array.from(onlineUsers.keys()));
  });

  socket.on('chat message', (data) => {
    const text = (data.message || '').trim().toLowerCase();
    
    // === COMMAND: status ===
    if (text === 'status') {
      const info = readSystemInfo();
      const msg = formatSystemMsg(info);
      
      // Kirim sebagai pesan sistem (tidak disimpan ke DB)
      io.emit('system', msg);
      
      // Log ke console
      console.log('[CMD] status dari', socket.username || 'Anonymous');
      return;
    }
    
    // === COMMAND: help ===
    if (text === 'help' || text === 'bantuan') {
      io.emit('system', '📋 Commands: status · help · ping');
      return;
    }
    
    // === COMMAND: ping ===
    if (text === 'ping') {
      io.emit('system', '🏓 Pong!');
      return;
    }

    // === Pesan biasa ===
    const msg = {
      username: data.username || socket.username || 'Anonymous',
      message: data.message || null,
      image_url: data.image_url || null,
      time: new Date().toLocaleTimeString('id-ID')
    };

    try {
      msg.id = saveMessage(msg.username, msg.message, msg.image_url, msg.time);
    } catch (err) {
      console.error('Save error:', err);
    }

    io.emit('chat message', msg);
  });

  socket.on('private message', (data) => {
    const { to, message, image_url } = data;
    const from = socket.username;

    const msg = {
      from_user: from,
      to_user: to,
      message: message || null,
      image_url: image_url || null,
      time: new Date().toLocaleTimeString('id-ID')
    };

    try {
      msg.id = savePrivateMessage(from, to, msg.message, msg.image_url, msg.time);
    } catch (err) {
      console.error('Save private error:', err);
    }

    socket.emit('private message', msg);

    const recipientSocket = onlineUsers.get(to);
    if (recipientSocket) {
      io.to(recipientSocket).emit('private message', msg);
    }
  });

  socket.on('get private history', (otherUser) => {
    const history = getPrivateMessages(socket.username, otherUser);
    socket.emit('private history', { with: otherUser, messages: history });
    markPrivateAsRead(otherUser, socket.username);
  });
  // ==== ROOM CHAT ====
  socket.on('create room', (data) => {
    const { name, pin, isPrivate } = data;
    const result = createRoom(name, pin, socket.username, isPrivate ? 1 : 0);
    
    if (result.success) {
      io.emit('room created', {
        id: result.id,
        name,
        created_by: socket.username,
        is_private: isPrivate ? 1 : 0
      });
      socket.emit('room created success', { id: result.id, name });
    } else {
      socket.emit('room error', result.error);
    }
  });

  socket.on('get rooms', () => {
    socket.emit('rooms list', getRooms());
  });

  socket.on('join room', (data) => {
    const { roomId, pin } = data;
    const room = verifyRoomPin(roomId, pin);
    
    if (!room) {
      socket.emit('room error', 'PIN salah');
      return;
    }
    
    // Leave room sebelumnya
    if (socket.currentRoom) {
      socket.leave('room_' + socket.currentRoom);
    }
    
    socket.currentRoom = roomId;
    socket.join('room_' + roomId);
    
    const history = getRoomMessages(roomId);
    socket.emit('room joined', { room, history });
    
    socket.to('room_' + roomId).emit('system', `${socket.username} joined room`);
  });

  socket.on('leave room', () => {
    if (socket.currentRoom) {
      socket.leave('room_' + socket.currentRoom);
      socket.to('room_' + socket.currentRoom).emit('system', `${socket.username} left room`);
      socket.currentRoom = null;
    }
  });

  socket.on('room message', (data) => {
    if (!socket.currentRoom) return;
    
    const msg = {
      room_id: socket.currentRoom,
      username: socket.username,
      message: data.message || null,
      image_url: data.image_url || null,
      time: new Date().toLocaleTimeString('id-ID')
    };
    
    try {
      msg.id = saveRoomMessage(socket.currentRoom, msg.username, msg.message, msg.image_url, msg.time);
    } catch (err) {
      console.error('Save room error:', err);
    }
    
    io.to('room_' + socket.currentRoom).emit('room message', msg);
  });
  // ==== VIDEO CALL SIGNALING ====
  
  // User A panggil User B
  socket.on('call user', (data) => {
    const { to, offer } = data;
    const targetSocket = onlineUsers.get(to);
    
    if (targetSocket) {
      io.to(targetSocket).emit('incoming call', {
        from: socket.username,
        offer
      });
    } else {
      socket.emit('call failed', { reason: 'User tidak online' });
    }
  });

  // User B jawab panggilan
  socket.on('answer call', (data) => {
    const { to, answer } = data;
    const targetSocket = onlineUsers.get(to);
    
    if (targetSocket) {
      io.to(targetSocket).emit('call answered', {
        from: socket.username,
        answer
      });
    }
  });

  // User B tolak panggilan
  socket.on('reject call', (data) => {
    const { to } = data;
    const targetSocket = onlineUsers.get(to);
    
    if (targetSocket) {
      io.to(targetSocket).emit('call rejected', {
        from: socket.username
      });
    }
  });

  // Kirim ICE candidate
  socket.on('ice candidate', (data) => {
    const { to, candidate } = data;
    const targetSocket = onlineUsers.get(to);
    
    if (targetSocket) {
      io.to(targetSocket).emit('ice candidate', {
        from: socket.username,
        candidate
      });
    }
  });

  // Akhiri panggilan
  socket.on('end call', (data) => {
    const { to } = data;
    const targetSocket = onlineUsers.get(to);
    
    if (targetSocket) {
      io.to(targetSocket).emit('call ended', {
        from: socket.username
      });
    }
  });
  socket.on('get threat stats', () => { socket.emit('threat stats', getCowrieStats()); });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('system', `${socket.username} left`);
      io.emit('online users', Array.from(onlineUsers.keys()));
    }
  });
});

const PORT = 3001;

// DISABLED: startCowrieWatcher();

initDb().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Chat server running on http://127.0.0.1:${PORT}`);
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`DB: ${DB_PATH}`);
  });
}).catch(err => {
  console.error('Init DB error:', err);
  process.exit(1);
});
