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
    this.state = "idle"; // idle | playing | paused | buffering | ended
    this.BUFFER_EDGE_SEC = 0.05;
    this.playheadSec = 0;
    this.knownDurationSec = 0;
    this.totalDurationSec = 0;
    this.isScrubbing = false;
    this.rafId = 0;
    /** @type {{ playheadSec: number, ctxTime: number } | null} */
    this._playbackAnchor = null;
    /** End of the Web Audio pipeline (session timeline + ctx time). */
    this._scheduleTimelineSec = null;
    this._scheduleCtxTime = null;
    this.onStateChange = null;
    this.onPlayRequest = null;
    this.onPlaybackControl = null;

    ui.btnPlay.addEventListener("click", () => {
      if (this.onPlayRequest?.()) return;
      this.togglePlay();
    });
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

  getBufferedEndSec() {
    return this.knownDurationSec;
  }

  isStreamingSession() {
    return this.session?.mode === "streaming" && this.session?.jobRunning;
  }

  getStreamingPlayheadCap() {
    return Math.max(0, this.getBufferedEndSec() - 0.001);
  }

  getClockPlayheadSec() {
    if (this.state !== "playing" || !this.ctx) {
      return this.playheadSec;
    }
    if (this.isStreamingSession() && this._playbackAnchor) {
      const elapsed = this.ctx.currentTime - this._playbackAnchor.ctxTime;
      return this._playbackAnchor.playheadSec + Math.max(0, elapsed);
    }
    if (this.anchorCtxTime != null) {
      return this.anchorPlayhead + (this.ctx.currentTime - this.anchorCtxTime);
    }
    return this.playheadSec;
  }

  getPlayheadSec() {
    let ph = this.getClockPlayheadSec();
    if (this.state === "playing" && this.isStreamingSession()) {
      const cap = this.getStreamingPlayheadCap();
      if (ph > cap) ph = cap;
    }
    return ph;
  }

  setPlaybackAnchor(playheadSec) {
    if (!this.ctx) return;
    const bufEnd = this.getBufferedEndSec();
    const ph =
      bufEnd > 0
        ? Math.max(0, Math.min(playheadSec, bufEnd - 0.001))
        : Math.max(0, playheadSec);
    this.playheadSec = ph;
    this.anchorPlayhead = ph;
    this.anchorCtxTime = this.ctx.currentTime;
    this._playbackAnchor = { playheadSec: ph, ctxTime: this.ctx.currentTime };
  }

  clearPlaybackAnchor() {
    this._playbackAnchor = null;
    this.anchorCtxTime = null;
  }

  clearSchedulePipeline() {
    this._scheduleTimelineSec = null;
    this._scheduleCtxTime = null;
  }

  /** Session timeline position to use when (re)starting playback. */
  getAudioPlayheadSec() {
    if (
      this._scheduleTimelineSec != null &&
      this.state === "playing" &&
      this.scheduledSources.length > 0
    ) {
      const clockPh = this.getClockPlayheadSec();
      if (clockPh > this._scheduleTimelineSec + 0.15) {
        return this._scheduleTimelineSec;
      }
    }
    return this.getPlayheadSec();
  }

  checkStreamBufferUnderrun() {
    if (this.state !== "playing") return;
    if (!this.isStreamingSession()) return;

    const bufEnd = this.getBufferedEndSec();
    if (bufEnd <= 0) {
      this.enterBufferWait();
      return;
    }

    const ph = this.getPlayheadSec();
    if (this.scheduledSources.length === 0) {
      if (ph >= bufEnd - this.BUFFER_EDGE_SEC) {
        this.enterBufferWait();
      } else {
        this.scheduleFrom(this.getAudioPlayheadSec());
      }
    }
  }

  syncPlayheadClock(playheadSec = this.playheadSec) {
    this.setPlaybackAnchor(playheadSec);
  }

  wantsStreamPlayback() {
    return (
      this.state === "playing" ||
      (this.state === "buffering" && this.session?.wantsPlay)
    );
  }

  getPlaybackChunkIndex() {
    if (!this.session?.chunks.length) return 0;
    const ph = this.getPlayheadSec();
    let index = this.session.chunks[0].index;
    for (const ch of this.session.chunks) {
      if (ph >= ch.startSec - 0.01) index = ch.index;
    }
    if (this.session.mode === "file" && index === 0) {
      return 1;
    }
    return index;
  }

  getChunkProgress() {
    if (!this.session) return null;
    const loaded = this.session.chunks?.length ?? 0;
    const total =
      this.session.totalChunks ||
      (this.session.mode === "file" && loaded > 0 ? 1 : 0);
    if (loaded === 0 && total === 0) return null;
    const current = loaded > 0 ? this.getPlaybackChunkIndex() : 0;
    return { current, loaded, total };
  }

  formatChunkProgress() {
    const p = this.getChunkProgress();
    if (!p) return "";
    const totalStr = p.total > 0 ? String(p.total) : "?";
    return `${p.current}/${p.loaded}/${totalStr}`;
  }

  notifyPlaybackControl() {
    if (!this.session?.jobRunning) return;
    this.onPlaybackControl?.({
      playing: this.wantsStreamPlayback(),
      playbackChunkIndex: this.getPlaybackChunkIndex(),
    });
  }

  enterBufferWait() {
    if (this.state !== "playing" || this.session?.mode !== "streaming") return;
    if (!this.session?.jobRunning) return;

    const bufEnd = this.getBufferedEndSec();
    const ph = this.getClockPlayheadSec();
    this.playheadSec =
      bufEnd > 0 ? Math.max(0, Math.min(ph, bufEnd - 0.001)) : 0;
    this.stopScheduled();
    this.clearSchedulePipeline();
    this.clearPlaybackAnchor();
    this.anchorPlayhead = this.playheadSec;
    this.state = "buffering";
    if (this.session) this.session.wantsPlay = true;
    this.notifyPlaybackControl();
    this.emitState();
  }

  async resumeAfterBuffer() {
    if (!this.session?.wantsPlay || this.knownDurationSec <= 0) return;
    await this.resumeContext();
    this.state = "playing";
    this.syncPlayheadClock(this.playheadSec);
    this.scheduleFrom(this.playheadSec);
    this.startUiLoop();
    this.notifyPlaybackControl();
    this.emitState();
  }

  /** Estimate full length from average duration of received chunks × total chunk count. */
  updateEstimatedTotal() {
    const totalChunks = this.session?.totalChunks;
    const received = this.session?.chunks?.length ?? 0;
    if (!totalChunks || received === 0) return;

    const avgSecPerChunk = this.knownDurationSec / received;
    this.totalDurationSec = avgSecPerChunk * totalChunks;

    if (received >= totalChunks) {
      this.totalDurationSec = this.knownDurationSec;
    }
  }

  setStreamPlan(jobId, { totalChunks } = {}) {
    if (!this.session || this.session.jobId !== jobId) return;
    if (totalChunks > 0) {
      this.session.totalChunks = totalChunks;
      this.updateEstimatedTotal();
      this.emitState();
    }
  }

  emitState() {
    this.onStateChange?.(this.state);
    this.syncUi();
  }

  getSeekMaxSec() {
    const hasChunkEstimate =
      this.session?.mode === "streaming" &&
      this.session.totalChunks > 0 &&
      this.totalDurationSec > 0;
    const displayTotal = hasChunkEstimate
      ? this.totalDurationSec
      : Math.max(this.totalDurationSec, this.knownDurationSec, 0.001);
    return Math.max(displayTotal, this.knownDurationSec, 0.001);
  }

  /** Cap seek thumb / playhead to received audio during streaming. */
  getSeekValueSec(playheadSec = this.getPlayheadSec()) {
    const seekMax = this.getSeekMaxSec();
    let ph = Math.min(Math.max(0, playheadSec), seekMax);
    if (this.isStreamingSession() && this.knownDurationSec > 0) {
      ph = Math.min(ph, this.getStreamingPlayheadCap());
    }
    return ph;
  }

  syncUi() {
    if (this.state === "playing") {
      this.checkStreamBufferUnderrun();
    }
    const { btnPlay, seek, timeLabel, chunksLabel } = this.ui;
    const playhead = this.getPlayheadSec();
    const hasChunkEstimate =
      this.session?.mode === "streaming" &&
      this.session.totalChunks > 0 &&
      this.totalDurationSec > 0;
    const displayTotal = hasChunkEstimate
      ? this.totalDurationSec
      : Math.max(this.totalDurationSec, this.knownDurationSec, 0.001);
    const seekMax = this.getSeekMaxSec();
    const atEnd =
      this.knownDurationSec > 0 && playhead >= this.knownDurationSec - 0.05;

    btnPlay.disabled = false;
    const showPause = this.state === "playing" || this.state === "buffering";
    btnPlay.textContent = showPause ? "⏸" : "▶";
    btnPlay.setAttribute("aria-label", showPause ? "Pause" : "Play");

    const displayPlayhead = this.getSeekValueSec(playhead);

    if (!this.isScrubbing) {
      seek.max = String(seekMax);
      seek.value = String(displayPlayhead);
      seek.disabled = !hasChunkEstimate && this.knownDurationSec <= 0;
    }

    const totalLabel =
      !hasChunkEstimate && this.knownDurationSec <= 0
        ? `${this.formatTime(playhead)} / —`
        : `${this.formatTime(displayPlayhead)} / ${this.formatTime(displayTotal)}`;

    timeLabel.textContent = totalLabel;

    if (chunksLabel) {
      const progress = this.formatChunkProgress();
      chunksLabel.textContent = progress;
      chunksLabel.hidden = !progress;
    }

    if (this.state === "ended" || (atEnd && this.session?.mode === "file")) {
      btnPlay.textContent = "▶";
    }
  }

  stopUiLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  startUiLoop() {
    this.stopUiLoop();
    const loop = () => {
      if (this.state !== "playing" && this.state !== "buffering") {
        this.rafId = 0;
        return;
      }
      if (this.state === "playing") {
        this.checkStreamBufferUnderrun();
        const ph = this.getPlayheadSec();
        const chunkIdx = this.getPlaybackChunkIndex();
        if (chunkIdx !== this._lastNotifiedChunk) {
          this._lastNotifiedChunk = chunkIdx;
          this.notifyPlaybackControl();
        }
        if (ph >= this.knownDurationSec - 0.02) {
          if (this.session?.mode === "file") {
            this.pause();
            this.playheadSec = this.knownDurationSec;
            this.state = "ended";
            this.emitState();
            this.rafId = 0;
            return;
          }
          if (!this.session?.jobRunning) {
            this.pause();
            this.state = "paused";
            this.emitState();
            this.rafId = 0;
            return;
          }
        }
      }
      this.syncUi();
      this.rafId = requestAnimationFrame(loop);
    };
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
    this.clearSchedulePipeline();
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

  beginSession(
    jobId,
    { title = "", estimatedTotalSec = 0, autoPlayOnChunk = false } = {}
  ) {
    this.stopPreview();
    this.stopScheduled();
    this.session = {
      jobId,
      title,
      mode: "streaming",
      jobRunning: true,
      autoPlayOnChunk,
      wantsPlay: autoPlayOnChunk,
      chunks: [],
      totalChunks: 0,
      sampleRate: 24000,
    };
    this.playheadSec = 0;
    this.knownDurationSec = 0;
    this.totalDurationSec = estimatedTotalSec;
    this.state = "idle";
    this.anchorCtxTime = null;
    this.anchorPlayhead = 0;
    this._lastNotifiedChunk = 0;
    this.clearPlaybackAnchor();
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
    if (meta.totalChunks > 0) {
      this.session.totalChunks = meta.totalChunks;
    }
    this.knownDurationSec += durationSec;
    this.updateEstimatedTotal();

    const ph = this.getPlayheadSec();
    const atLiveEdge =
      this.state === "playing" && ph >= startSec - this.BUFFER_EDGE_SEC;
    const resumeFromBuffer =
      this.state === "buffering" && this.session.wantsPlay;

    if (resumeFromBuffer) {
      await this.resumeAfterBuffer();
    } else if (atLiveEdge && this.session.wantsPlay) {
      await this.resumeContext();
      this.state = "playing";
      const newChunk = this.session.chunks[this.session.chunks.length - 1];
      if (
        this.scheduledSources.length > 0 &&
        this._scheduleCtxTime != null &&
        this._scheduleTimelineSec != null
      ) {
        this.appendChunkToPipeline(newChunk);
      } else {
        const resumeAt =
          this._scheduleTimelineSec != null
            ? Math.min(this._scheduleTimelineSec, startSec)
            : Math.min(this.getAudioPlayheadSec(), startSec);
        this.scheduleFrom(resumeAt);
      }
      this.startUiLoop();
    } else if (this.session.autoPlayOnChunk && this.session.chunks.length === 1) {
      this.session.autoPlayOnChunk = false;
      this.session.wantsPlay = true;
      this.play().catch((e) => console.error("Auto-play failed", e));
    }

    this.notifyPlaybackControl();
    this.emitState();
  }

  _bindScheduledSource(src) {
    src.onended = () => {
      const idx = this.scheduledSources.indexOf(src);
      if (idx >= 0) this.scheduledSources.splice(idx, 1);
      if (this.state !== "playing") return;
      if (
        this.scheduledSources.length === 0 &&
        this._scheduleTimelineSec != null
      ) {
        this.playheadSec = this._scheduleTimelineSec;
        this.syncPlayheadClock(this.playheadSec);
      }
      this.checkStreamBufferUnderrun();
    };
  }

  scheduleChunkPortion(ch, timelineSec, ctxWhen) {
    const offset = Math.max(0, timelineSec - ch.startSec);
    const dur = ch.durationSec - offset;
    if (dur <= 0.001) return null;

    const ctx = this.ensureContext();
    const src = ctx.createBufferSource();
    src.buffer = ch.buffer;
    src.connect(this.sessionGain);
    src.start(ctxWhen, offset, dur);
    this.scheduledSources.push(src);
    this._bindScheduledSource(src);
    this._scheduleCtxTime = ctxWhen + dur;
    this._scheduleTimelineSec = ch.startSec + ch.durationSec;
    return src;
  }

  appendChunkToPipeline(ch) {
    if (this._scheduleTimelineSec == null || this._scheduleCtxTime == null) {
      this.scheduleFrom(ch.startSec);
      return;
    }
    if (ch.startSec + ch.durationSec <= this._scheduleTimelineSec + 0.0001) {
      return;
    }
    const timelineSec = Math.max(ch.startSec, this._scheduleTimelineSec);
    this.scheduleChunkPortion(ch, timelineSec, this._scheduleCtxTime);
  }

  scheduleFrom(playheadSec) {
    this.stopScheduled();
    if (!this.session?.chunks.length) return;

    const ctx = this.ensureContext();
    const bufEnd = this.getBufferedEndSec();
    const startPh =
      bufEnd > 0
        ? Math.max(0, Math.min(playheadSec, bufEnd - 0.001))
        : Math.max(0, playheadSec);
    this.setPlaybackAnchor(startPh);

    let when = ctx.currentTime;
    let t = startPh;

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
      this._bindScheduledSource(src);
      when += dur;
      t = ch.startSec + ch.durationSec;
    }
    if (t > startPh + 0.0001) {
      this._scheduleCtxTime = when;
      this._scheduleTimelineSec = t;
    }
  }

  async play() {
    if (!this.session) return;
    await this.resumeContext();
    this.stopPreview();

    if (this.session) this.session.wantsPlay = true;

    if (this.knownDurationSec <= 0) {
      this.state = "buffering";
      this.playheadSec = 0;
      this.clearPlaybackAnchor();
      this.startUiLoop();
      this.notifyPlaybackControl();
      this.emitState();
      return;
    }

    let ph = this.playheadSec;
    if (ph >= this.knownDurationSec - 0.05) ph = 0;

    this.state = "playing";
    this.syncPlayheadClock(ph);
    this.scheduleFrom(this.getAudioPlayheadSec());
    this.startUiLoop();
    this.notifyPlaybackControl();
    this.emitState();
  }

  pause() {
    if (this.state === "playing" || this.state === "buffering") {
      this.playheadSec = this.getPlayheadSec();
    }
    this.stopScheduled();
    this.state = "paused";
    this.clearPlaybackAnchor();
    if (this.session) this.session.wantsPlay = false;
    this.stopUiLoop();
    this.notifyPlaybackControl();
    this.emitState();
  }

  togglePlay() {
    if (this.state === "playing" || this.state === "buffering") this.pause();
    else this.play();
  }

  seek(sec) {
    const max = this.getSeekMaxSec();
    this.playheadSec = this.getSeekValueSec(Math.max(0, Math.min(sec, max)));
    if (this.state === "playing" || this.state === "buffering") {
      this.ensureContext();
      if (this.session) this.session.wantsPlay = true;
      if (this.playheadSec < this.knownDurationSec - this.BUFFER_EDGE_SEC) {
        this.state = "playing";
        this.scheduleFrom(this.getAudioPlayheadSec());
        this.startUiLoop();
      } else {
        this.stopScheduled();
        this.state = "buffering";
        this.clearPlaybackAnchor();
        this.anchorPlayhead = this.playheadSec;
        this.startUiLoop();
      }
    }
    this.notifyPlaybackControl();
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
    if (reason === "ended" && this.knownDurationSec > 0) {
      this.totalDurationSec = this.knownDurationSec;
    }
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
    this.stopUiLoop();
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
    chunksLabel: document.getElementById("player-chunks"),
    btnMute,
    muteIcon: btnMute?.querySelector(".mute-icon path"),
    muteLabel: btnMute?.querySelector(".mute-label"),
  });
}
