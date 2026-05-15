/**
 * Streaming + file playback with play/pause/seek and shared mute (master gain).
 */
class AudioPlayer {
  constructor(ui) {
    this.ui = ui;
    this.ctx = null;
    this.masterGain = null;
    this.sessionGain = null;
    this.session = null;
    this.scheduledSources = [];
    this.previewSource = null;
    this.isMuted = true;
    this.state = "idle"; // idle | playing | paused | ended
    this.playheadSec = 0;
    this.knownDurationSec = 0;
    this.totalDurationSec = 0;
    this.isScrubbing = false;
    this.rafId = 0;
    this.onStateChange = null;

    ui.btnPlay.addEventListener("click", () => this.togglePlay());
    ui.btnMute.addEventListener("click", () => this.setMuted(!this.isMuted));
    ui.seek.addEventListener("input", () => {
      this.isScrubbing = true;
      this.seek(parseFloat(ui.seek.value) || 0);
    });
    ui.seek.addEventListener("change", () => {
      this.isScrubbing = false;
    });
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this.sessionGain = this.ctx.createGain();
      this.sessionGain.connect(this.masterGain);
      this.applyMuteGain();
    }
    return this.ctx;
  }

  async resumeContext() {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") await ctx.resume();
  }

  applyMuteGain() {
    if (this.masterGain) {
      this.masterGain.gain.value = this.isMuted ? 0 : 1;
    }
  }

  setMuted(muted) {
    this.isMuted = muted;
    this.applyMuteGain();
    this.updateMuteUi();
    localStorage.setItem("livePlaybackMuted", muted ? "1" : "0");
  }

  setInitialMuted(muted) {
    this.isMuted = muted;
    this.applyMuteGain();
    this.updateMuteUi();
  }

  updateMuteUi() {
    const { btnMute, muteIcon, muteLabel } = this.ui;
    btnMute.classList.toggle("is-muted", this.isMuted);
    btnMute.setAttribute("aria-pressed", String(this.isMuted));
    btnMute.title = this.isMuted ? "Muted — click to unmute" : "Sound on — click to mute";
    if (muteLabel) muteLabel.textContent = this.isMuted ? "Muted" : "Sound on";
    if (muteIcon) {
      muteIcon.setAttribute(
        "d",
        this.isMuted ? AudioPlayer.MUTE_ICON : AudioPlayer.UNMUTE_ICON
      );
    }
  }

  formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  getPlayheadSec() {
    if (this.state === "playing" && this.ctx && this.anchorCtxTime != null) {
      return this.anchorPlayhead + (this.ctx.currentTime - this.anchorCtxTime);
    }
    return this.playheadSec;
  }

  emitState() {
    this.onStateChange?.(this.state);
    this.syncUi();
  }

  syncUi() {
    const { btnPlay, seek, timeLabel } = this.ui;
    const playhead = this.getPlayheadSec();
    const total = Math.max(this.totalDurationSec, this.knownDurationSec, 0.001);
    const atEnd =
      this.knownDurationSec > 0 && playhead >= this.knownDurationSec - 0.05;

    btnPlay.disabled = !this.session || this.knownDurationSec <= 0;
    btnPlay.textContent = this.state === "playing" ? "⏸" : "▶";
    btnPlay.setAttribute(
      "aria-label",
      this.state === "playing" ? "Pause" : "Play"
    );

    if (!this.isScrubbing) {
      seek.max = String(total);
      seek.value = String(Math.min(playhead, total));
      seek.disabled = this.knownDurationSec <= 0;
    }

    const totalLabel =
      this.session?.mode === "streaming" && this.totalDurationSec > this.knownDurationSec
        ? `${this.formatTime(playhead)} / ${this.formatTime(this.knownDurationSec)} (${this.formatTime(this.totalDurationSec)} est.)`
        : `${this.formatTime(playhead)} / ${this.formatTime(total)}`;

    timeLabel.textContent = totalLabel;

    if (this.state === "ended" || (atEnd && this.session?.mode === "file")) {
      btnPlay.textContent = "▶";
    }
  }

  startUiLoop() {
    const loop = () => {
      if (this.state === "playing") {
        const ph = this.getPlayheadSec();
        if (ph >= this.knownDurationSec - 0.02) {
          if (this.session?.mode === "file") {
            this.pause();
            this.playheadSec = this.knownDurationSec;
            this.state = "ended";
            this.emitState();
          } else if (!this.session?.jobRunning) {
            this.pause();
            this.state = "paused";
            this.emitState();
          }
        }
        this.syncUi();
      }
      this.rafId = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(loop);
  }

  async decodeB64(b64) {
    await this.resumeContext();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return this.ctx.decodeAudioData(bytes.buffer.slice(0));
  }

  stopScheduled() {
    for (const src of this.scheduledSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    this.scheduledSources = [];
  }

  stopPreview() {
    if (this.previewSource) {
      try {
        this.previewSource.stop();
      } catch {
        /* noop */
      }
      try {
        this.previewSource.disconnect();
      } catch {
        /* noop */
      }
      this.previewSource = null;
    }
  }

  beginSession(jobId, { title = "", estimatedTotalSec = 0 } = {}) {
    this.stopPreview();
    this.stopScheduled();
    this.session = {
      jobId,
      title,
      mode: "streaming",
      jobRunning: true,
      chunks: [],
      sampleRate: 24000,
    };
    this.playheadSec = 0;
    this.knownDurationSec = 0;
    this.totalDurationSec = estimatedTotalSec;
    this.state = "idle";
    this.anchorCtxTime = null;
    this.anchorPlayhead = 0;
    this.emitState();
  }

  async appendChunk(jobId, b64, meta) {
    if (!this.session || this.session.jobId !== jobId) return;

    const buffer = await this.decodeB64(b64);
    const durationSec = buffer.duration;
    const startSec = this.knownDurationSec;

    this.session.chunks.push({
      index: meta.chunkIndex,
      buffer,
      startSec,
      durationSec,
    });
    if (meta.sampleRate) this.session.sampleRate = meta.sampleRate;
    this.knownDurationSec += durationSec;

    if (meta.totalDuration && meta.totalDuration > this.knownDurationSec) {
      this.totalDurationSec = meta.totalDuration;
    } else if (meta.totalChunks && meta.chunkIndex) {
      this.totalDurationSec = (this.knownDurationSec / meta.chunkIndex) * meta.totalChunks;
    }

    const wasAtLiveEdge =
      this.state === "playing" &&
      this.getPlayheadSec() >= startSec - 0.15;

    if (wasAtLiveEdge) {
      this.scheduleChunkAt(this.session.chunks[this.session.chunks.length - 1], 0);
    }

    this.emitState();
  }

  scheduleChunkAt(chunk, offsetInChunk) {
    const ctx = this.ensureContext();
    const dur = chunk.durationSec - offsetInChunk;
    if (dur <= 0) return;

    const src = ctx.createBufferSource();
    src.buffer = chunk.buffer;
    src.connect(this.sessionGain);
    const when = ctx.currentTime;
    src.start(when, offsetInChunk, dur);
    this.scheduledSources.push(src);

    src.onended = () => {
      const idx = this.scheduledSources.indexOf(src);
      if (idx >= 0) this.scheduledSources.splice(idx, 1);
      if (
        this.state === "playing" &&
        this.scheduledSources.length === 0 &&
        this.session?.jobRunning &&
        this.getPlayheadSec() >= this.knownDurationSec - 0.1
      ) {
        /* wait for more chunks */
      }
    };
  }

  scheduleFrom(playheadSec) {
    this.stopScheduled();
    if (!this.session?.chunks.length) return;

    const ctx = this.ensureContext();
    let when = ctx.currentTime;
    let t = playheadSec;

    for (const ch of this.session.chunks) {
      const chEnd = ch.startSec + ch.durationSec;
      if (chEnd <= t + 0.0001) continue;

      const offset = Math.max(0, t - ch.startSec);
      const dur = ch.durationSec - offset;
      if (dur <= 0.001) continue;

      const src = ctx.createBufferSource();
      src.buffer = ch.buffer;
      src.connect(this.sessionGain);
      src.start(when, offset, dur);
      this.scheduledSources.push(src);
      when += dur;
      t = ch.startSec + ch.durationSec;
    }
  }

  async play() {
    if (!this.session || this.knownDurationSec <= 0) return;
    await this.resumeContext();
    this.stopPreview();

    let ph = this.playheadSec;
    if (ph >= this.knownDurationSec - 0.05) ph = 0;

    this.playheadSec = ph;
    this.anchorPlayhead = ph;
    this.anchorCtxTime = this.ctx.currentTime;
    this.state = "playing";
    this.scheduleFrom(ph);
    this.startUiLoop();
    this.emitState();
  }

  pause() {
    if (this.state === "playing") {
      this.playheadSec = this.getPlayheadSec();
    }
    this.stopScheduled();
    this.state = "paused";
    this.anchorCtxTime = null;
    this.emitState();
  }

  togglePlay() {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  seek(sec) {
    const max = Math.max(this.knownDurationSec, 0);
    this.playheadSec = Math.max(0, Math.min(sec, max));
    if (this.state === "playing") {
      this.anchorPlayhead = this.playheadSec;
      this.anchorCtxTime = this.ctx.currentTime;
      this.scheduleFrom(this.playheadSec);
    }
    this.syncUi();
  }

  async loadFile(jobId, filePath, durationHint) {
    if (!this.session || this.session.jobId !== jobId) return;
    try {
      const b64 = await window.ttsApp.readFileBase64(filePath);
      const buffer = await this.decodeB64(b64);
      this.stopScheduled();
      this.session.mode = "file";
      this.session.jobRunning = false;
      this.session.chunks = [
        { index: 0, buffer, startSec: 0, durationSec: buffer.duration },
      ];
      this.knownDurationSec = buffer.duration;
      this.totalDurationSec = durationHint || buffer.duration;
      if (this.state === "playing" && this.getPlayheadSec() > this.knownDurationSec) {
        this.playheadSec = 0;
        this.pause();
      }
      this.emitState();
    } catch (e) {
      console.error("Failed to load output file for playback", e);
    }
  }

  endSession(jobId, { reason = "ended" } = {}) {
    if (this.session?.jobId !== jobId) return;
    this.session.jobRunning = false;
    if (reason === "error" || reason === "cancelled") {
      this.stopScheduled();
      this.stopPreview();
      if (reason === "cancelled") this.state = "idle";
    }
    this.emitState();
  }

  async playPreview(b64) {
    await this.resumeContext();
    this.pause();
    this.stopPreview();
    const buffer = await this.decodeB64(b64);
    return new Promise((resolve, reject) => {
      const src = this.ctx.createBufferSource();
      this.previewSource = src;
      src.buffer = buffer;
      src.connect(this.masterGain);
      src.onended = () => {
        this.previewSource = null;
        resolve();
      };
      try {
        src.start(0);
      } catch (e) {
        reject(e);
      }
    });
  }

  reset() {
    this.pause();
    this.stopPreview();
    this.session = null;
    this.knownDurationSec = 0;
    this.totalDurationSec = 0;
    this.playheadSec = 0;
    this.state = "idle";
    this.emitState();
  }
}

AudioPlayer.MUTE_ICON =
  "M16.5 12a4.5 4.5 0 0 0-1.9-3.7l1.4-1.4A6.5 6.5 0 0 1 18.5 12c0 1.8-.7 3.4-1.9 4.6l-1.4-1.4A4.5 4.5 0 0 0 16.5 12ZM3 9v6h4l5 5V4L7 9H3zm14.3 2.3 1.4 1.4L22.4 9l-3.7-3.7-1.4 1.4L19.6 9l-2.3 2.3z";
AudioPlayer.UNMUTE_ICON =
  "M3 9v6h4l5 5V4L7 9H3zm7.5 3.5c0-1.77 1.02-3.29 2.5-4.03v8.05a4.48 4.48 0 0 1-2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z";

function createAudioPlayer() {
  const btnMute = document.getElementById("player-mute");
  return new AudioPlayer({
    btnPlay: document.getElementById("player-play"),
    seek: document.getElementById("player-seek"),
    timeLabel: document.getElementById("player-time"),
    btnMute,
    muteIcon: btnMute?.querySelector(".mute-icon path"),
    muteLabel: btnMute?.querySelector(".mute-label"),
  });
}
