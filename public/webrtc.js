// =====================================================
// WEBRTC - Video Call Module (REVISED v2)
// Fix: Tombol call tidak hilang + penerima bisa lihat video pemanggil
// =====================================================

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
};

let pc = null;
let localStream = null;
let remoteUser = null;
let isCaller = false;
let callActive = false;
let pendingOffer = null;
let pendingFrom = null;

// Helper: ambil element dengan aman
function $id(id) { return document.getElementById(id); }

// =====================================================
// 1. INISIALISASI PEER CONNECTION
// =====================================================
function createPeerConnection() {
  const peer = new RTCPeerConnection(RTC_CONFIG);

  peer.onicecandidate = (event) => {
    if (event.candidate && remoteUser) {
      socket.emit('ice candidate', { to: remoteUser, candidate: event.candidate });
    }
  };

  peer.ontrack = (event) => {
    console.log('[WebRTC] ontrack:', event.track.kind);
    const remoteVideo = $id('remote-video');
    if (remoteVideo && remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(err => console.warn('remote play:', err));
    }
  };

  peer.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', peer.connectionState);
    const callInfo = $id('call-info');
    if (callInfo) callInfo.textContent = 'Status: ' + peer.connectionState;
    if (peer.connectionState === 'connected' && callInfo) {
      callInfo.textContent = 'Terhubung';
      setTimeout(() => { callInfo.style.display = 'none'; }, 2000);
    }
  };

  peer.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE:', peer.iceConnectionState);
  };

  return peer;
}

// =====================================================
// 2. MEDIA LOKAL
// =====================================================
async function getLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 } },
    audio: true
  });
  const localVideo = $id('local-video');
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.play().catch(err => console.warn('local play:', err));
  }
  return localStream;
}

// =====================================================
// 3. PEMANGGIL
// =====================================================
async function startCall(targetUser) {
  if (callActive) return;
  remoteUser = targetUser;
  isCaller = true;
  callActive = true;

  try {
    const callModal = $id('call-modal');
    const callInfo = $id('call-info');
    if (callModal) callModal.classList.remove('hidden');
    if (callInfo) {
      callInfo.textContent = 'Memanggil ' + targetUser + '...';
      callInfo.style.display = 'block';
    }

    const stream = await getLocalStream();
    pc = createPeerConnection();
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call user', { to: targetUser, offer });
  } catch (err) {
    console.error('[WebRTC] startCall error:', err);
    alert('Gagal memulai panggilan: ' + err.message);
    cleanupCall();
  }
}

// =====================================================
// 4. PENERIMA
// =====================================================
async function acceptCall() {
  if (!pendingOffer || !pendingFrom) return;
  const incomingCallModal = $id('incoming-call-modal');
  const callModal = $id('call-modal');
  const callInfo = $id('call-info');
  if (incomingCallModal) incomingCallModal.classList.add('hidden');
  if (callModal) callModal.classList.remove('hidden');

  try {
    remoteUser = pendingFrom;
    isCaller = false;
    callActive = true;
    if (callInfo) {
      callInfo.textContent = 'Menghubungkan...';
      callInfo.style.display = 'block';
    }

    const stream = await getLocalStream();
    pc = createPeerConnection();

    // PENTING: setRemoteDescription DULU
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));

    // Baru tambah track lokal
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer call', { to: remoteUser, answer });

    pendingOffer = null;
    pendingFrom = null;
  } catch (err) {
    console.error('[WebRTC] acceptCall error:', err);
    alert('Gagal menerima panggilan: ' + err.message);
    cleanupCall();
  }
}

// =====================================================
// 5. SIGNALING HANDLER
// =====================================================
socket.on('call answered', async (data) => {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    const callInfo = $id('call-info');
    if (callInfo) callInfo.textContent = 'Terhubung';
  } catch (err) {
    console.error('[WebRTC] setRemote(answer) error:', err);
  }
});

socket.on('incoming call', (data) => {
  pendingOffer = data.offer;
  pendingFrom = data.from;
  const nameEl = $id('incoming-caller-name');
  const modal = $id('incoming-call-modal');
  if (nameEl) nameEl.textContent = data.from;
  if (modal) modal.classList.remove('hidden');
});

socket.on('call rejected', () => {
  alert('Panggilan ditolak');
  cleanupCall();
});

socket.on('ice candidate', async (data) => {
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.error('[WebRTC] addIceCandidate error:', err);
  }
});

socket.on('call ended', () => { cleanupCall(); });

socket.on('call failed', (data) => {
  alert('Panggilan gagal: ' + (data.reason || 'unknown'));
  cleanupCall();
});

// =====================================================
// 6. UI BINDINGS — pasang setelah DOM siap
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
  const callBtn = $id('call-btn');
  const acceptCallBtn = $id('accept-call-btn');
  const rejectCallBtn = $id('reject-call-btn');
  const endCallBtn = $id('end-call-btn');
  const muteBtn = $id('mute-btn');
  const toggleVideoBtn = $id('toggle-video-btn');

  if (callBtn) {
    callBtn.addEventListener('click', () => {
      if (typeof currentChat !== 'undefined' && currentChat.startsWith('private:')) {
        const target = currentChat.replace('private:', '');
        if (target && target !== username) startCall(target);
      }
    });
  }

  if (acceptCallBtn) acceptCallBtn.addEventListener('click', acceptCall);

  if (rejectCallBtn) {
    rejectCallBtn.addEventListener('click', () => {
      if (pendingFrom) socket.emit('reject call', { to: pendingFrom });
      pendingOffer = null;
      pendingFrom = null;
      const modal = $id('incoming-call-modal');
      if (modal) modal.classList.add('hidden');
    });
  }

  if (endCallBtn) {
    endCallBtn.addEventListener('click', () => {
      if (remoteUser) socket.emit('end call', { to: remoteUser });
      cleanupCall();
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      if (!localStream) return;
      const t = localStream.getAudioTracks()[0];
      if (t) {
        t.enabled = !t.enabled;
        muteBtn.textContent = t.enabled ? '🎤' : '🔇';
      }
    });
  }

  if (toggleVideoBtn) {
    toggleVideoBtn.addEventListener('click', () => {
      if (!localStream) return;
      const t = localStream.getVideoTracks()[0];
      if (t) {
        t.enabled = !t.enabled;
        toggleVideoBtn.textContent = t.enabled ? '📹' : '🚫';
      }
    });
  }
});

// =====================================================
// 7. CLEANUP
// =====================================================
function cleanupCall() {
  callActive = false;
  remoteUser = null;
  isCaller = false;

  if (pc) {
    pc.getSenders().forEach(s => { if (s.track) s.track.stop(); });
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  const localVideo = $id('local-video');
  const remoteVideo = $id('remote-video');
  const callModal = $id('call-modal');
  const incomingCallModal = $id('incoming-call-modal');
  const callInfo = $id('call-info');
  const muteBtn = $id('mute-btn');
  const toggleVideoBtn = $id('toggle-video-btn');

  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (callModal) callModal.classList.add('hidden');
  if (incomingCallModal) incomingCallModal.classList.add('hidden');
  if (callInfo) {
    callInfo.style.display = 'block';
    callInfo.textContent = 'Menghubungkan...';
  }
  if (muteBtn) muteBtn.textContent = '🎤';
  if (toggleVideoBtn) toggleVideoBtn.textContent = '📹';
}

window.WebRTC = { startCall, acceptCall, cleanupCall };
