// =====================================================
// CHAT FRONTEND - script.js
// Sudah include: tombol call muncul saat private chat
// =====================================================

// =====================================================
// DARK MODE TOGGLE
// =====================================================
(function initTheme() {
  const saved = localStorage.getItem('chat_theme');
  if (saved === 'dark') {
    document.body.classList.add('dark-mode');
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  // Set ikon sesuai tema saat ini
  const updateIcon = () => {
    themeToggle.textContent = document.body.classList.contains('dark-mode') ? '☀️' : '🌙';
  };
  updateIcon();

  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('chat_theme', isDark ? 'dark' : 'light');
    updateIcon();
  });
});

const socket = io();
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');
const status = document.getElementById('status');
const loginModal = document.getElementById('login-modal');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const fileInput = document.getElementById('file-input');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const cancelImage = document.getElementById('cancel-image');
const chatTitle = document.getElementById('chat-title');
const backBtn = document.getElementById('back-btn');
const onlineList = document.getElementById('online-users');
const onlineCount = document.getElementById('online-count');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.querySelector('.sidebar');
const roomsList = document.getElementById('rooms-list');
const createRoomBtn = document.getElementById('create-room-btn');
const roomModal = document.getElementById('room-modal');
const roomName = document.getElementById('room-name');
const roomPin = document.getElementById('room-pin');
const roomPrivate = document.getElementById('room-private');
const createRoomSubmit = document.getElementById('create-room-submit');
const roomCancel = document.getElementById('room-cancel');
const joinRoomModal = document.getElementById('join-room-modal');
const joinRoomName = document.getElementById('join-room-name');
const joinRoomPin = document.getElementById('join-room-pin');
const joinRoomSubmit = document.getElementById('join-room-submit');
const joinCancel = document.getElementById('join-cancel');
const tabOnline = document.getElementById('tab-online');
const tabRooms = document.getElementById('tab-rooms');
const callBtn = document.getElementById('call-btn'); // ✅ tombol video call

let username = '';
let pendingImage = null;
let currentChat = 'public'; // 'public', 'private:user', 'room:id'
let onlineUsersList = [];
let roomsData = [];
let selectedRoom = null;

// =====================================================
// LOGIN
// =====================================================
const savedName = localStorage.getItem('chat_username');
if (savedName) {
  username = savedName;
  joinChat();
}

joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (name) {
    username = name;
    localStorage.setItem('chat_username', name);
    joinChat();
  }
});

usernameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

function joinChat() {
  loginModal.classList.add('hidden');
  input.disabled = false;
  form.querySelector('button').disabled = false;
  input.focus();
  socket.emit('join', username);
  status.textContent = `Online sebagai ${username}`;
}

// =====================================================
// TABS (Online / Rooms)
// =====================================================
tabOnline.addEventListener('click', () => {
  tabOnline.classList.add('active');
  tabRooms.classList.remove('active');
  onlineList.classList.remove('hidden');
  roomsList.classList.add('hidden');
});

tabRooms.addEventListener('click', () => {
  tabRooms.classList.add('active');
  tabOnline.classList.remove('active');
  roomsList.classList.remove('hidden');
  onlineList.classList.add('hidden');
  socket.emit('get rooms');
});

// =====================================================
// ONLINE USERS
// =====================================================
socket.on('online users', (users) => {
  onlineUsersList = users;
  onlineCount.textContent = users.length;
  renderOnlineUsers();
});

function renderOnlineUsers() {
  onlineList.innerHTML = '';
  onlineUsersList.sort().forEach(user => {
    const div = document.createElement('div');
    div.className = 'online-user';
    if (currentChat === 'private:' + user) div.classList.add('active');
    const initial = user.charAt(0).toUpperCase();
    const isMe = user === username;
    div.innerHTML = `
      <span class="dot"></span>
      <div class="avatar">${initial}</div>
      <span class="name ${isMe ? 'me' : ''}">${escapeHtml(user)}${isMe ? ' (kamu)' : ''}</span>
    `;
    if (!isMe) div.addEventListener('click', () => openPrivateChat(user));
    onlineList.appendChild(div);
  });
}

// =====================================================
// ROOMS
// =====================================================
socket.on('rooms list', (rooms) => {
  roomsData = rooms;
  renderRooms();
});

socket.on('room created', () => {
  socket.emit('get rooms');
});

socket.on('room created success', (data) => {
  roomModal.classList.add('hidden');
  const pinUsed = roomPin.value.trim();
  roomName.value = '';
  roomPin.value = '';
  selectedRoom = data;
  socket.emit('join room', { roomId: data.id, pin: pinUsed || '0000' });
});

socket.on('room error', (msg) => {
  alert(msg);
});

socket.on('room joined', (data) => {
  currentChat = 'room:' + data.room.id;
  chatTitle.textContent = `🚪 ${data.room.name}`;
  backBtn.classList.remove('hidden');
  // Sembunyikan tombol call di room chat
  if (callBtn) callBtn.classList.add('hidden');
  messages.innerHTML = '';
  data.history.forEach(msg => addRoomMessage(msg));
  sidebar.classList.remove('open');
  renderRooms();
});

function renderRooms() {
  roomsList.innerHTML = '';
  if (roomsData.length === 0) {
    roomsList.innerHTML = '<p style="color:#8696a0;font-size:0.85rem;padding:12px;text-align:center;">Belum ada room</p>';
    return;
  }
  roomsData.forEach(room => {
    const div = document.createElement('div');
    div.className = 'room-item';
    if (currentChat === 'room:' + room.id) div.classList.add('active');
    div.innerHTML = `
      <div class="room-name">
        ${room.is_private ? '<span class="lock">🔒</span>' : '<span class="lock">🌐</span>'}
        ${escapeHtml(room.name)}
      </div>
      <div class="room-meta">by ${escapeHtml(room.created_by)}</div>
    `;
    div.addEventListener('click', () => {
      if (room.is_private) {
        selectedRoom = room;
        joinRoomName.textContent = `Room: ${room.name}`;
        joinRoomPin.value = '';
        joinRoomModal.classList.remove('hidden');
        setTimeout(() => joinRoomPin.focus(), 100);
      } else {
        socket.emit('join room', { roomId: room.id, pin: '' });
      }
    });
    roomsList.appendChild(div);
  });
}

// Buat room
createRoomBtn.addEventListener('click', () => {
  roomModal.classList.remove('hidden');
  setTimeout(() => roomName.focus(), 100);
});

roomCancel.addEventListener('click', () => {
  roomModal.classList.add('hidden');
});

createRoomSubmit.addEventListener('click', () => {
  const name = roomName.value.trim();
  const pin = roomPin.value.trim();
  if (!name) return alert('Nama room harus diisi');
  if (roomPrivate.checked && (pin.length < 4 || pin.length > 6)) {
    return alert('PIN harus 4-6 digit');
  }
  socket.emit('create room', { name, pin: pin || '0000', isPrivate: roomPrivate.checked });
});

// Join room
joinRoomSubmit.addEventListener('click', () => {
  const pin = joinRoomPin.value.trim();
  if (!pin) return alert('Masukkan PIN');
  socket.emit('join room', { roomId: selectedRoom.id, pin });
  joinRoomModal.classList.add('hidden');
});

joinCancel.addEventListener('click', () => {
  joinRoomModal.classList.add('hidden');
});

joinRoomPin.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinRoomSubmit.click();
});

// =====================================================
// PRIVATE CHAT
// =====================================================
function openPrivateChat(otherUser) {
  if (otherUser === username) return;
  currentChat = 'private:' + otherUser;
  chatTitle.textContent = `Chat dengan ${otherUser}`;
  backBtn.classList.remove('hidden');
  messages.innerHTML = '';
  socket.emit('get private history', otherUser);
  renderOnlineUsers();
  sidebar.classList.remove('open');

  // ✅ MUNCULKAN tombol video call
  if (callBtn) callBtn.classList.remove('hidden');
}

backBtn.addEventListener('click', () => {
  currentChat = 'public';
  chatTitle.textContent = 'Chat Room';
  backBtn.classList.add('hidden');
  messages.innerHTML = '';

  // ✅ SEMBUNYIKAN tombol video call saat kembali ke public
  if (callBtn) callBtn.classList.add('hidden');

  fetch('/chat/api/messages')
    .then(r => r.json())
    .then(history => {
      messages.innerHTML = '';
      history.forEach(msg => addMessage(msg, msg.username === username));
    });
  renderOnlineUsers();
});

sidebarToggle.addEventListener('click', () => {
  if (window.innerWidth <= 700) {
    sidebar.classList.toggle('open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
});

// =====================================================
// UPLOAD GAMBAR
// =====================================================
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return alert('Ukuran gambar maksimal 5 MB');

  const formData = new FormData();
  formData.append('image', file);
  try {
    status.textContent = 'Mengupload...';
    const res = await fetch('/chat/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.url) {
      pendingImage = data.url;
      previewImg.src = data.url;
      imagePreview.classList.remove('hidden');
      status.textContent = `Online sebagai ${username}`;
    }
  } catch (err) {
    status.textContent = 'Upload gagal';
  }
  fileInput.value = '';
});

cancelImage.addEventListener('click', () => {
  pendingImage = null;
  imagePreview.classList.add('hidden');
});

// =====================================================
// KIRIM PESAN
// =====================================================
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg && !pendingImage) return;

  if (currentChat === 'public') {
    socket.emit('chat message', { username, message: msg || null, image_url: pendingImage });
  } else if (currentChat.startsWith('private:')) {
    socket.emit('private message', {
      to: currentChat.replace('private:', ''),
      message: msg || null,
      image_url: pendingImage
    });
  } else if (currentChat.startsWith('room:')) {
    socket.emit('room message', { message: msg || null, image_url: pendingImage });
  }

  input.value = '';
  pendingImage = null;
  imagePreview.classList.add('hidden');
});

// =====================================================
// TERIMA PESAN
// =====================================================
socket.on('chat message', (data) => {
  if (currentChat === 'public') addMessage(data, data.username === username);
});

socket.on('private message', (data) => {
  const otherUser = data.from_user === username ? data.to_user : data.from_user;
  if (currentChat === 'private:' + otherUser) addPrivateMessage(data);
  else status.textContent = `💬 Pesan baru dari ${data.from_user}`;
});

socket.on('room message', (data) => {
  if (currentChat === 'room:' + data.room_id) addRoomMessage(data);
});

socket.on('private history', (data) => {
  messages.innerHTML = '';
  data.messages.forEach(msg => addPrivateMessage(msg));
});

socket.on('history', (history) => {
  if (currentChat === 'public') {
    messages.innerHTML = '';
    history.forEach(msg => addMessage(msg, msg.username === username));
  }
});

socket.on('system', (msg) => {
  if (currentChat === 'public' || currentChat.startsWith('room:')) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = msg;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }
});

socket.on('connect', () => {
  status.textContent = username ? `Online sebagai ${username}` : 'Terhubung';
});

socket.on('disconnect', () => {
  status.textContent = 'Terputus';
});

// =====================================================
// RENDER PESAN
// =====================================================
function addMessage(data, isOwn) {
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : 'other'}`;
  let html = `<div class="meta"><span class="name" onclick="openPrivateChat('${escapeHtml(data.username)}')">${escapeHtml(data.username)}</span><span>${data.time}</span></div>`;
  if (data.message) html += `<div>${escapeHtml(data.message)}</div>`;
  if (data.image_url) html += `<img src="${escapeHtml(data.image_url)}" onclick="window.open(this.src)" />`;
  div.innerHTML = html;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addPrivateMessage(data) {
  const isOwn = data.from_user === username;
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : 'other'}`;
  let html = `<div class="meta"><span class="name">${escapeHtml(data.from_user)}</span><span>${data.time}</span></div>`;
  if (data.message) html += `<div>${escapeHtml(data.message)}</div>`;
  if (data.image_url) html += `<img src="${escapeHtml(data.image_url)}" onclick="window.open(this.src)" />`;
  div.innerHTML = html;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addRoomMessage(data) {
  const isOwn = data.username === username;
  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : 'other'}`;
  let html = `<div class="meta"><span class="name">${escapeHtml(data.username)}</span><span>${data.time}</span></div>`;
  if (data.message) html += `<div>${escapeHtml(data.message)}</div>`;
  if (data.image_url) html += `<img src="${escapeHtml(data.image_url)}" onclick="window.open(this.src)" />`;
  div.innerHTML = html;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// =====================================================
// UTIL
// =====================================================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.openPrivateChat = openPrivateChat;
