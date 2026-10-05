/*
 * Browser half of the Reflex <-> LiveKit bridge (camera video + microphone audio).
 *
 * LiveKitBridgeState drives this object with rx.call_script(...):
 *   window.livekitClient.connect(url, token, bridgeInputId)
 *   window.livekitClient.setMicrophone(enabled)
 *   window.livekitClient.setCamera(enabled)
 *   window.livekitClient.startAudio()
 *   window.livekitClient.disconnect()
 * and receives room updates as JSON through a hidden <input> whose onChange
 * is bound to LiveKitBridgeState.handle_js_message.
 *
 * Reflex renders the video tiles: each has a <video data-lk-identity="...">,
 * and syncVideo() attaches that participant's camera track to it. React may
 * create, re-create or remove those elements at any time, so the attachments
 * are synced again after every room event and every DOM change.
 *
 * Needs /livekit-client.umd.js (vendored livekit-client, global LivekitClient).
 */
(function () {
  if (window.livekitClient) return;

  // The SDK disconnects by itself when the page goes away (reload, close);
  // that is not a dropped connection, so don't report it to the backend.
  let leaving = false;
  window.addEventListener('beforeunload', () => { leaving = true; });
  window.addEventListener('pagehide', () => { leaving = true; });

  // <video> element -> the camera track attached to it.
  const attached = new WeakMap();

  // The backend hands us its own URL (ws://localhost:8000 locally,
  // wss://<sub>.reflex-ddns.com behind re-ddns); the SDK appends /rtc.
  function signalUrl(url) {
    const u = new URL(url, window.location.href);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (window.location.protocol === 'https:' && u.protocol === 'ws:') u.protocol = 'wss:';
    return u.toString().replace(/\/$/, '');
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
    return letters.toUpperCase();
  }

  function avatarColor(seed) {
    let hue = 0;
    for (const ch of String(seed)) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    return 'hsl(' + hue + ' 65% 50%)';
  }

  function errorText(error) {
    return (error && error.message) || String(error);
  }

  function audioHolder() {
    let holder = document.getElementById('livekit-audio-holder');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'livekit-audio-holder';
      holder.style.display = 'none';
      document.body.appendChild(holder);
    }
    return holder;
  }

  // The camera track to show for a participant: null while the camera is off
  // (or, for others, before we are subscribed to it).
  function cameraTrack(participant) {
    const pub = participant.getTrackPublication(window.LivekitClient.Track.Source.Camera);
    return pub && pub.track && !pub.isMuted ? pub.track : null;
  }

  window.livekitClient = {
    room: null,
    audioInterval: null,
    bridgeInputId: null,
    domObserver: null,
    syncTimer: null,

    async connect(url, token, bridgeInputId) {
      this.bridgeInputId = bridgeInputId;
      const LK = window.LivekitClient;
      if (!LK) {
        this.sendStatus({ type: 'error', message: 'livekit-client.umd.js failed to load' });
        return;
      }
      if (this.room) await this.disconnect();

      const room = new LK.Room({
        // Others' video comes in the resolution of the tile showing it, and
        // not at all while no tile is visible.
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        videoCaptureDefaults: { resolution: LK.VideoPresets.h720.resolution },
        publishDefaults: { audioPreset: LK.AudioPresets.music, simulcast: true },
      });
      this.room = room;
      const E = LK.RoomEvent;
      const refresh = () => this.updateParticipants();

      room
        .on(E.Connected, () => this.sendStatus({ status: 'Connected' }))
        .on(E.Reconnecting, () => this.sendStatus({ status: 'Reconnecting...' }))
        .on(E.Reconnected, () => this.sendStatus({ status: 'Connected' }))
        .on(E.ParticipantConnected, refresh)
        .on(E.ParticipantDisconnected, refresh)
        .on(E.ActiveSpeakersChanged, refresh)
        .on(E.TrackMuted, refresh)
        .on(E.TrackUnmuted, refresh)
        .on(E.TrackPublished, refresh)
        .on(E.TrackUnpublished, refresh)
        .on(E.LocalTrackPublished, refresh)
        .on(E.LocalTrackUnpublished, refresh)
        .on(E.TrackSubscribed, (track) => {
          // Keep remote audio elements in the DOM (as LiveKit's own demo does);
          // video goes into the tiles (syncVideo).
          if (track.kind === 'audio') audioHolder().appendChild(track.attach());
          refresh();
        })
        .on(E.TrackUnsubscribed, (track) => {
          // Audio elements are ours to remove; the <video> elements belong to React.
          track.detach().forEach((el) => {
            if (track.kind === 'audio') el.remove();
            else attached.delete(el);
          });
          refresh();
        })
        .on(E.AudioPlaybackStatusChanged, () => {
          this.sendStatus({ audio_blocked: !room.canPlaybackAudio });
        })
        .on(E.MediaDevicesError, (e) => {
          this.sendStatus({ type: 'warning', message: 'Camera/microphone error: ' + errorText(e) });
        })
        .on(E.Disconnected, () => {
          // Ignore the event caused by our own disconnect() (leave / rejoin).
          if (this.room !== room || leaving) return;
          this.room = null;
          this.stopAudioVisualizer();
          this.unwatchDom();
          this.syncVideo();
          this.sendStatus({ status: 'Disconnected', participants: [] });
        });

      try {
        await room.connect(signalUrl(url), token);
      } catch (error) {
        console.error('LiveKit connection error:', error);
        if (this.room === room) this.room = null;
        this.sendStatus({ type: 'error', message: errorText(error) });
        return;
      }

      await this.enableMedia(room);
      if (this.room !== room) return;  // left while the browser asked for permissions

      this.updateParticipants();
      this.startAudioVisualizer();
      this.watchDom();
      this.sendStatus({ status: 'Connected', audio_blocked: !room.canPlaybackAudio });
    },

    // Camera and microphone with a single permission prompt. If that fails (no
    // camera, permission denied, ...) try each on its own: either is enough
    // to take part, and with neither we still see and hear the others.
    async enableMedia(room) {
      const local = room.localParticipant;
      try {
        await local.enableCameraAndMicrophone();
        return;
      } catch (error) {
        console.warn('Camera + microphone failed, trying each on its own:', error);
      }
      try {
        await local.setMicrophoneEnabled(true);
      } catch (error) {
        this.sendStatus({ type: 'warning', message: 'Joined without microphone: ' + errorText(error) });
      }
      try {
        await local.setCameraEnabled(true);
      } catch (error) {
        this.sendStatus({ type: 'warning', message: 'Joined without camera: ' + errorText(error) });
      }
    },

    async disconnect() {
      const room = this.room;
      this.room = null;
      this.stopAudioVisualizer();
      this.unwatchDom();
      if (room) await room.disconnect();
      audioHolder().replaceChildren();
      this.syncVideo();
    },

    async setMicrophone(enabled) {
      if (!this.room) return;
      try {
        await this.room.localParticipant.setMicrophoneEnabled(enabled);
      } catch (error) {
        this.sendStatus({ type: 'warning', message: 'Microphone error: ' + errorText(error) });
      }
      this.updateParticipants();
    },

    async setCamera(enabled) {
      if (!this.room) return;
      try {
        // Turning it off stops the camera itself (its light goes off), not just the video.
        await this.room.localParticipant.setCameraEnabled(enabled);
      } catch (error) {
        this.sendStatus({ type: 'warning', message: 'Camera error: ' + errorText(error) });
      }
      this.updateParticipants();
    },

    async startAudio() {
      if (!this.room) return;
      await this.room.startAudio();
      this.sendStatus({ audio_blocked: !this.room.canPlaybackAudio });
    },

    // Attach every participant's camera to the <video data-lk-identity> of its tile.
    syncVideo() {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      const room = this.room;
      const wanted = new Map();
      if (room) {
        wanted.set(room.localParticipant.identity, cameraTrack(room.localParticipant));
        room.remoteParticipants.forEach((p) => wanted.set(p.identity, cameraTrack(p)));
      }
      document.querySelectorAll('video[data-lk-identity]').forEach((el) => {
        const track = wanted.get(el.dataset.lkIdentity) || null;
        const current = attached.get(el) || null;
        if (current === track) return;
        if (current) current.detach(el);
        if (track) {
          track.attach(el);
          attached.set(el, track);
        } else {
          attached.delete(el);
        }
      });
      // Let go of the elements React removed, so adaptive stream stops counting them.
      wanted.forEach((track) => {
        if (!track) return;
        track.attachedElements.filter((el) => !el.isConnected).forEach((el) => track.detach(el));
      });
    },

    scheduleSync() {
      if (this.syncTimer === null) this.syncTimer = setTimeout(() => this.syncVideo(), 0);
    },

    // React adds tiles after the state update that announced the participant,
    // and may replace a tile's <video>: sync after such DOM changes too.
    watchDom() {
      if (this.domObserver) return;
      this.domObserver = new MutationObserver(() => this.scheduleSync());
      this.domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-lk-identity'],
      });
    },

    unwatchDom() {
      if (this.domObserver) {
        this.domObserver.disconnect();
        this.domObserver = null;
      }
    },

    startAudioVisualizer() {
      this.stopAudioVisualizer();
      this.audioInterval = setInterval(() => {
        if (!this.room) return;
        const updateBar = (p) => {
          const el = document.getElementById('vol-' + p.identity);
          if (!el) return;
          const level = p.audioLevel || 0;
          let width = Math.min(100, level * 100 * 5);
          if (width > 0 && width < 5) width = 5;
          el.style.width = width + '%';
        };
        updateBar(this.room.localParticipant);
        this.room.remoteParticipants.forEach(updateBar);
      }, 50);
    },

    stopAudioVisualizer() {
      if (this.audioInterval) {
        clearInterval(this.audioInterval);
        this.audioInterval = null;
      }
    },

    updateParticipants() {
      const room = this.room;
      if (!room) return;
      const describe = (p, isLocal) => {
        const name = p.name || p.identity;
        return {
          identity: p.identity,
          name: name,
          initials: initials(name),
          avatar_color: avatarColor(name),
          is_speaking: p.isSpeaking,
          is_local: isLocal,
          is_muted: !p.isMicrophoneEnabled,
          has_video: !!cameraTrack(p),
        };
      };
      const participants = [describe(room.localParticipant, true)];
      room.remoteParticipants.forEach((p) => participants.push(describe(p, false)));
      this.sendStatus({
        participants: participants,
        is_muted: !room.localParticipant.isMicrophoneEnabled,
        is_camera_off: !room.localParticipant.isCameraEnabled,
      });
      this.scheduleSync();
    },

    sendStatus(data) {
      const input = document.getElementById(this.bridgeInputId);
      if (!input) return;
      // React ignores plain value assignments; use the native setter + input event.
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setValue.call(input, JSON.stringify(data));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
})();
