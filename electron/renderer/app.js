/** @typedef {{ id: string, title: string, status: string, progress: number, outputPath?: string, error?: string }} Job */

const $ = (sel) => document.querySelector(sel);

const textInput = $("#text-input");
const dropZone = $("#drop-zone");
const voiceSelect = $("#voice-select");
const emotionSelect = $("#emotion-select");
const btnPreview = $("#btn-preview");
let previewLoading = false;
let previewPlaying = false;
let previewStoppedByUser = false;
const outputDir = $("#output-dir");
const jobList = $("#job-list");
const queueEmpty = $("#queue-empty");
const modelStatus = $("#model-status");
const footerStatus = $("#footer-status");
const dictRows = $("#dict-rows");
const viewSynthesize = $("#view-synthesize");
const viewSettings = $("#view-settings");
const navButtons = document.querySelectorAll(".nav-btn");

const player = createAudioPlayer();
const footerEl = document.querySelector(".footer");

const modelSetup = $("#model-setup");
const modelSetupPath = $("#model-setup-path");
const modelSetupProgress = $("#model-setup-progress");
const modelDlBar = $("#model-dl-bar");
const modelDlStatus = $("#model-dl-status");
const modelSetupError = $("#model-setup-error");
const btnDownloadModels = $("#btn-download-models");

let modelsReady = false;
let modelDownloadRunning = false;
let dictionaryLoaded = false;
let currentView = "synthesize";

const PREF_OUTPUT_DIR = "outputDir";
const PREF_VOICE_ID = "voiceId";
const PREF_EMOTION = "emotion";

function loadSynthPreferences() {
  const savedDir = localStorage.getItem(PREF_OUTPUT_DIR);
  if (savedDir) outputDir.value = savedDir;

  const savedEmotion = localStorage.getItem(PREF_EMOTION);
  if (
    savedEmotion &&
    [...emotionSelect.options].some((o) => o.value === savedEmotion)
  ) {
    emotionSelect.value = savedEmotion;
  }
}

function applySavedVoice() {
  const savedVoice = localStorage.getItem(PREF_VOICE_ID);
  if (
    savedVoice &&
    [...voiceSelect.options].some((o) => o.value === savedVoice)
  ) {
    voiceSelect.value = savedVoice;
    return;
  }
  if (voiceSelect.options.length && !voiceSelect.value) {
    voiceSelect.value =
      [...voiceSelect.options].find((o) => o.value === "Doan")?.value ||
      voiceSelect.options[0].value;
  }
}

function applyLiveSynthSettings() {
  if (streamJob?.status === "running") {
    window.ttsApp
      .rpc("set_job_synth_config", {
        jobId: streamJob.id,
        voiceId: voiceSelect.value,
        emotion: emotionSelect.value,
      })
      .catch(() => {});
    return;
  }
  const runningJob = jobs.find((j) => j.status === "running");
  if (runningJob) {
    window.ttsApp
      .rpc("set_job_synth_config", {
        jobId: runningJob.id,
        voiceId: voiceSelect.value,
        emotion: emotionSelect.value,
      })
      .catch(() => {});
  }
}

function bindSynthPreferences() {
  voiceSelect.addEventListener("change", () => {
    if (voiceSelect.value) localStorage.setItem(PREF_VOICE_ID, voiceSelect.value);
    applyLiveSynthSettings();
  });
  emotionSelect.addEventListener("change", () => {
    if (emotionSelect.value) localStorage.setItem(PREF_EMOTION, emotionSelect.value);
    applyLiveSynthSettings();
  });
}

function saveOutputDir(dir) {
  if (!dir) return;
  outputDir.value = dir;
  localStorage.setItem(PREF_OUTPUT_DIR, dir);
}

function setAppLocked(locked) {
  document.body.classList.toggle("app-locked", locked);
}

function showModelSetup(show) {
  modelSetup.hidden = !show;
  setAppLocked(show);
}

function setModelDownloadError(message) {
  if (message) {
    modelSetupError.hidden = false;
    modelSetupError.textContent = message;
  } else {
    modelSetupError.hidden = true;
    modelSetupError.textContent = "";
  }
}

function setModelDownloadProgress(percent, message) {
  modelSetupProgress.hidden = false;
  modelDlBar.style.width = `${Math.round(percent * 100)}%`;
  if (message) modelDlStatus.textContent = message;
}

async function refreshModelsPath() {
  try {
    const p = await window.ttsApp.getModelsPath();
    modelSetupPath.textContent = `Storage: ${p}`;
  } catch {
    modelSetupPath.textContent = "";
  }
}

async function checkModelsInstalled() {
  const status = await window.ttsApp.rpc("check_models");
  modelsReady = Boolean(status.installed);
  return status;
}

async function onModelsReady() {
  modelsReady = true;
  showModelSetup(false);
  setModelDownloadError("");
  modelSetupProgress.hidden = true;
  btnDownloadModels.disabled = false;
  modelDownloadRunning = false;

  setModelStatus("Loading model…", "loading");
  try {
    await window.ttsApp.rpc("warmup");
    await loadVoices();
    setModelStatus("Ready", "ready");
    setStatus("Models ready");
  } catch (e) {
    setModelStatus("Error", "");
    setStatus(`Model load failed: ${e.message}`, { isError: true });
    modelsReady = false;
    showModelSetup(true);
    setModelDownloadError(e.message);
  }
}

async function startModelDownload() {
  if (modelDownloadRunning || modelsReady) return;
  modelDownloadRunning = true;
  btnDownloadModels.disabled = true;
  setModelDownloadError("");
  modelSetupProgress.hidden = false;
  modelDlBar.style.width = "0%";
  modelDlStatus.textContent = "Starting download…";
  setStatus("Downloading speech models…");

  try {
    const result = await window.ttsApp.rpc("download_models");
    if (result?.status === "already_installed") {
      await onModelsReady();
    }
  } catch (e) {
    if (!modelsReady) {
      setModelDownloadError(e.message);
      setStatus(`Download failed: ${e.message}`, { isError: true });
      btnDownloadModels.disabled = false;
      modelDownloadRunning = false;
    }
  }
}

function handleModelEvent(event) {
  if (event.type === "model_download_started") {
    modelSetupProgress.hidden = false;
    modelDlBar.style.width = "0%";
    modelDlStatus.textContent = "Downloading…";
    return;
  }
  if (event.type === "model_download_phase") {
    const label = event.phase === "codec" ? "Codec" : "Voice model";
    modelDlStatus.textContent = `Downloading ${label}…`;
    return;
  }
  if (event.type === "model_download_progress") {
    const pct = event.percent ?? 0;
    setModelDownloadProgress(pct, event.message || "Downloading…");
    return;
  }
  if (event.type === "model_download_complete") {
    onModelsReady();
    return;
  }
  if (event.type === "model_download_error") {
    setModelDownloadError(event.message);
    setStatus(`Download failed: ${event.message}`, { isError: true });
    btnDownloadModels.disabled = false;
    modelDownloadRunning = false;
  }
}

function requireModelsReady() {
  if (!modelsReady) {
    alert("Download speech models first using the setup screen.");
    return false;
  }
  return true;
}

/** @type {Job[]} */
const jobs = [];
let jobCounter = 0;
let userDictionary = {};
/** @type {{ id: string, status: string, title: string } | null} */
let streamJob = null;
let streamSourceText = null;
let lastStreamPlaybackSync = { playing: null, chunk: null };
let streamTextChangeTimer = null;
const STREAM_TEXT_DEBOUNCE_MS = 500;

function setStatus(msg, { isError = false } = {}) {
  footerStatus.textContent = msg;
  footerEl?.classList.toggle("footer-error", isError);
}

function showView(name) {
  currentView = name;
  const isSynth = name === "synthesize";

  viewSynthesize.classList.toggle("view-active", isSynth);
  viewSettings.classList.toggle("view-active", !isSynth);

  navButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });

  if (name === "settings" && !dictionaryLoaded) {
    loadDictionary().catch((e) => setStatus(`Dictionary: ${e.message}`));
  }
}

function setModelStatus(text, cls) {
  modelStatus.textContent = text;
  modelStatus.className = `badge ${cls || ""}`;
}

function renderJobs() {
  jobList.innerHTML = "";
  queueEmpty.classList.toggle("hidden", jobs.length > 0);

  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = `job-item status-${job.status}`;
    li.dataset.id = job.id;

    const pct = Math.round(job.progress * 100);
    li.innerHTML = `
      <div class="title">${escapeHtml(job.title)}</div>
      <div class="meta">${job.status} · ${pct}%${job.outputPath ? ` · ${basename(job.outputPath)}` : ""}</div>
      ${job.error ? `<div class="job-error">${escapeHtml(job.error)}</div>` : ""}
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="row" style="margin-top:0.4rem">
        ${job.status === "running" || job.status === "queued" ? `<button type="button" class="btn ghost small btn-cancel" data-id="${job.id}">Cancel</button>` : ""}
        ${job.status === "done" && job.outputPath ? `<button type="button" class="btn ghost small btn-reveal" data-path="${escapeAttr(job.outputPath)}">Show in Finder</button>` : ""}
        ${job.status === "done" && job.outputPath ? `<button type="button" class="btn ghost small btn-play-job" data-id="${job.id}">Play</button>` : ""}
      </div>
    `;

    li.querySelector(".btn-cancel")?.addEventListener("click", () => {
      window.ttsApp.rpc("cancel_job", { jobId: job.id });
      job.status = "cancelled";
      setStatus(`Cancelled: ${job.title}`);
      renderJobs();
    });
    li.querySelector(".btn-reveal")?.addEventListener("click", (e) => {
      window.ttsApp.showItemInFolder(e.target.dataset.path);
    });
    li.querySelector(".btn-play-job")?.addEventListener("click", async () => {
      if (!job.outputPath) return;
      player.beginSession(job.id, { title: job.title });
      player.knownDurationSec = 0;
      await player.loadFile(job.id, job.outputPath);
      player.play();
    });

    jobList.appendChild(li);
  }
}

function stripUnwantedChars(text) {
  return text.replace(/\u25a0/g, "");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function basename(p) {
  return p.split(/[/\\]/).pop();
}

function slugify(s) {
  return s
    .slice(0, 40)
    .replace(/[^\w\u00C0-\u024f]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "speech";
}

function getJob(id) {
  return jobs.find((j) => j.id === id);
}

async function loadVoices() {
  const { voices } = await window.ttsApp.rpc("list_voices");
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = `${v.id} — ${v.description}`;
    voiceSelect.appendChild(opt);
  }
  applySavedVoice();
}

async function loadDictionary() {
  const data = await window.ttsApp.rpc("get_dictionary");
  userDictionary = data.userDictionary || {};
  dictRows.innerHTML = "";
  const entries = Object.entries(userDictionary);
  if (entries.length === 0) addDictRow("", "");
  else entries.forEach(([k, v]) => addDictRow(k, v));
  dictionaryLoaded = true;
}

function addDictRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "dict-row";
  row.innerHTML = `
    <input type="text" class="dict-key" placeholder="From" value="${escapeAttr(key)}" />
    <input type="text" class="dict-val" placeholder="Speak as" value="${escapeAttr(value)}" />
    <button type="button" class="btn ghost small btn-rm">×</button>
  `;
  row.querySelector(".btn-rm").addEventListener("click", () => row.remove());
  dictRows.appendChild(row);
}

function collectDictionary() {
  const entries = {};
  dictRows.querySelectorAll(".dict-row").forEach((row) => {
    const k = row.querySelector(".dict-key").value.trim();
    const v = row.querySelector(".dict-val").value.trim();
    if (k) entries[k] = v;
  });
  return entries;
}

function failJob(job, message) {
  job.status = "error";
  job.error = message;
  window.ttsApp.rpc("cancel_job", { jobId: job.id }).catch(() => {});
  setStatus(`Error: ${message}`, { isError: true });
  renderJobs();
}

function failStreamJob(message) {
  if (streamJob) {
    player.endSession(streamJob.id, { reason: "error" });
    streamJob = null;
  }
  streamSourceText = null;
  setStatus(`Error: ${message}`, { isError: true });
}

function isStreamActive() {
  return Boolean(
    streamJob?.status === "running" || player.session?.jobRunning
  );
}

function stopStreamPlayback() {
  if (streamJob?.status === "running") {
    syncStreamPlaybackControl({ playing: false, playbackChunkIndex: 1 });
    window.ttsApp.rpc("cancel_job", { jobId: streamJob.id }).catch(() => {});
    player.endSession(streamJob.id, { reason: "cancelled" });
  } else if (player.session) {
    player.reset();
  }
  streamJob = null;
  streamSourceText = null;
  lastStreamPlaybackSync = { playing: null, chunk: null };
}

function getSynthText() {
  const cleaned = stripUnwantedChars(textInput.value).trim();
  if (!cleaned) return null;
  if (cleaned !== textInput.value) textInput.value = cleaned;
  return cleaned;
}

function streamJobTitle(text) {
  return text.slice(0, 48).replace(/\s+/g, " ") + (text.length > 48 ? "…" : "");
}

function syncStreamPlaybackControl({ playing, playbackChunkIndex } = {}) {
  if (!streamJob || streamJob.status !== "running") return;

  const isPlaying = playing ?? player.wantsStreamPlayback();
  const chunk = playbackChunkIndex ?? player.getPlaybackChunkIndex();

  if (
    lastStreamPlaybackSync.playing === isPlaying &&
    lastStreamPlaybackSync.chunk === chunk
  ) {
    return;
  }
  lastStreamPlaybackSync = { playing: isPlaying, chunk };

  window.ttsApp
    .rpc("set_job_playback", {
      jobId: streamJob.id,
      playing: isPlaying,
      playbackChunkIndex: chunk,
    })
    .catch(() => {});
}

async function startStreamPlayback({ autoPlay = true } = {}) {
  if (!requireModelsReady()) return false;

  const text = getSynthText();
  if (!text) {
    alert("Enter some text first.");
    return true;
  }

  if (streamJob?.status === "running") {
    syncStreamPlaybackControl({ playing: false, playbackChunkIndex: 1 });
    window.ttsApp.rpc("cancel_job", { jobId: streamJob.id }).catch(() => {});
    player.endSession(streamJob.id, { reason: "cancelled" });
  } else if (player.session) {
    player.reset();
  }

  const id = `stream-${++jobCounter}`;
  const title = streamJobTitle(text);
  streamJob = { id, status: "running", title };
  streamSourceText = text;
  lastStreamPlaybackSync = { playing: null, chunk: null };

  player.beginSession(id, { title, autoPlayOnChunk: autoPlay });
  setStatus(autoPlay ? `Playing: ${title}` : `Ready: ${title}`);

  try {
    await window.ttsApp.rpc("start_job", {
      jobId: id,
      text,
      saveOutput: false,
      voiceId: voiceSelect.value,
      emotion: emotionSelect.value,
      maxChunkChars: 350,
    });
    syncStreamPlaybackControl({
      playing: autoPlay,
      playbackChunkIndex: 1,
    });
  } catch (e) {
    failStreamJob(e.message);
  }
  return true;
}

function handleStreamTextChange() {
  if (streamSourceText === null && !isStreamActive() && !player.session) {
    return;
  }

  const current = getSynthText();

  if (!current) {
    if (isStreamActive() || player.session) {
      stopStreamPlayback();
      setStatus("Playback stopped — text is empty");
    }
    return;
  }

  if (current === streamSourceText) {
    return;
  }

  if (!isStreamActive() && !player.session) {
    streamSourceText = null;
    return;
  }

  const resumePlaying = player.wantsStreamPlayback();
  setStatus("Text changed — restarting…");
  startStreamPlayback({ autoPlay: resumePlaying });
}

async function enqueueJob(text, title) {
  if (!requireModelsReady()) return;

  const dir = outputDir.value.trim();
  if (!dir) {
    alert("Choose an output folder first.");
    return;
  }

  const id = `job-${++jobCounter}`;
  const filename = `${slugify(title)}-${id}.wav`;
  const outputPath = `${dir}/${filename}`;

  const job = {
    id,
    title: title || `Job ${jobCounter}`,
    status: "queued",
    progress: 0,
    outputPath,
  };
  jobs.unshift(job);
  renderJobs();

  try {
    await window.ttsApp.rpc("start_job", {
      jobId: id,
      text: stripUnwantedChars(text),
      outputPath,
      saveOutput: true,
      voiceId: voiceSelect.value,
      emotion: emotionSelect.value,
      maxChunkChars: 350,
    });
    job.status = "running";
    renderJobs();
    setStatus(`Generating: ${job.title}`);
  } catch (e) {
    failJob(job, e.message);
  }
}

function handleStreamEvent(event) {
  if (!streamJob || event.jobId !== streamJob.id) return false;
  if (streamJob.status === "error" || streamJob.status === "cancelled") return true;

  if (event.type === "chunk_audio" && event.audioWavBase64) {
    if (event.totalChunks) {
      player.setStreamPlan(streamJob.id, { totalChunks: event.totalChunks });
    }
    player
      .appendChunk(streamJob.id, event.audioWavBase64, {
        chunkIndex: event.chunkIndex,
        totalChunks: event.totalChunks,
        duration: event.duration,
        sampleRate: event.sampleRate,
      })
      .catch((e) => console.error("Chunk decode failed", e));
  } else if (event.type === "job_complete") {
    streamJob.status = "done";
    player.endSession(streamJob.id, { reason: "ended" });
    streamJob = null;
    if (getSynthText() === streamSourceText) {
      setStatus("Playback finished");
    }
  } else if (event.type === "job_error") {
    streamJob.status = "error";
    failStreamJob(event.message);
  } else if (event.type === "job_cancelled") {
    streamJob.status = "cancelled";
    player.endSession(streamJob.id, { reason: "cancelled" });
    streamJob = null;
    streamSourceText = null;
    setStatus("Playback cancelled");
  } else if (event.type === "job_started") {
    if (event.totalChunks) {
      player.setStreamPlan(streamJob.id, { totalChunks: event.totalChunks });
    }
    setStatus(`Playing: ${streamJob.title}`);
    syncStreamPlaybackControl({
      playing: player.wantsStreamPlayback(),
      playbackChunkIndex: 1,
    });
  } else if (event.type === "chunk_started") {
    player.syncUi();
  }
  return true;
}

function handleTtsEvent(event) {
  if (event.type?.startsWith("model_download")) {
    handleModelEvent(event);
    return;
  }

  if (event.jobId && handleStreamEvent(event)) return;

  const job = event.jobId ? getJob(event.jobId) : null;

  if (event.type === "model_loading") {
    setModelStatus("Loading model…", "loading");
    return;
  }
  if (event.type === "model_ready") {
    setModelStatus("Model ready", "ready");
    return;
  }
  if (!job) return;

  if (job.status === "error" || job.status === "cancelled") {
    return;
  }

  if (event.type === "job_started") {
    job.status = "running";
    job.progress = 0;
    job.totalChunks = event.totalChunks || 0;
  } else if (event.type === "chunk_started" && job.status === "running") {
    const total = event.totalChunks || job.totalChunks;
    if (total) {
      job.progress = (event.chunkIndex - 1) / total;
    }
  } else if (event.type === "chunk_done" && job.status === "running") {
    const total = event.totalChunks || job.totalChunks;
    if (total) {
      job.progress = event.chunkIndex / total;
    }
  } else if (event.type === "job_complete") {
    job.status = "done";
    job.progress = 1;
    job.outputPath = event.outputPath;
    setStatus(`Done: ${basename(event.outputPath)}`);
  } else if (event.type === "job_error") {
    failJob(job, event.message);
    return;
  } else if (event.type === "job_cancelled") {
    job.status = "cancelled";
    setStatus(`Cancelled: ${job.title}`);
  } else if (event.type === "warning") {
    console.warn(event.message);
  }

  renderJobs();
}

async function importFiles(paths) {
  for (const filePath of paths) {
    setStatus(`Importing ${basename(filePath)}…`);
    try {
      const { text } = await window.ttsApp.rpc("extract_text", { path: filePath });
      const title = basename(filePath);
      await enqueueJob(text, title);
    } catch (e) {
      setStatus(`Import failed: ${e.message}`, { isError: true });
    }
  }
}

async function init() {
  loadSynthPreferences();
  bindSynthPreferences();

  const savedMute = localStorage.getItem("livePlaybackMuted");
  player.setInitialMuted(savedMute === null ? true : savedMute !== "0");

  window.ttsApp.onEvent(handleTtsEvent);

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const files = [...e.dataTransfer.files];
    if (files.length === 1 && files[0].type.startsWith("text/")) {
      textInput.value = await files[0].text();
      return;
    }
    const paths = files
      .map((f) => window.ttsApp.getPathForFile(f))
      .filter(Boolean);
    if (paths.length) await importFiles(paths);
  });

  $("#btn-import").addEventListener("click", async () => {
    const paths = await window.ttsApp.pickInputFiles();
    if (paths.length) await importFiles(paths);
  });

  $("#btn-output-dir").addEventListener("click", async () => {
    const dir = await window.ttsApp.pickOutputDirectory(
      outputDir.value.trim() || localStorage.getItem(PREF_OUTPUT_DIR) || undefined
    );
    if (dir) saveOutputDir(dir);
  });

  $("#btn-download-models").addEventListener("click", () => startModelDownload());
  $("#btn-open-models-folder").addEventListener("click", () => {
    window.ttsApp.openModelsFolder();
  });

  $("#btn-generate").addEventListener("click", async () => {
    if (!requireModelsReady()) return;
    const cleaned = getSynthText();
    if (!cleaned) {
      alert("Enter some text first.");
      return;
    }
    await enqueueJob(cleaned, streamJobTitle(cleaned));
  });

  player.onPlayRequest = () => {
    const text = getSynthText();
    if (
      text &&
      streamSourceText !== null &&
      text !== streamSourceText
    ) {
      startStreamPlayback({ autoPlay: true });
      return true;
    }
    if (player.session?.jobRunning || player.knownDurationSec > 0) {
      return false;
    }
    startStreamPlayback();
    return true;
  };
  player.onPlaybackControl = ({ playing, playbackChunkIndex }) => {
    syncStreamPlaybackControl({ playing, playbackChunkIndex });
  };
  player.onStateChange = (state) => {
    if (state === "buffering" && streamJob?.status === "running") {
      setStatus(`Buffering: ${streamJob.title}…`);
    }
  };
  textInput.addEventListener("input", () => {
    clearTimeout(streamTextChangeTimer);
    streamTextChangeTimer = setTimeout(
      handleStreamTextChange,
      STREAM_TEXT_DEBOUNCE_MS
    );
  });
  player.syncUi();

  function syncPreviewButton() {
    if (previewPlaying) {
      btnPreview.textContent = "Stop sample";
      btnPreview.disabled = false;
    } else if (previewLoading) {
      btnPreview.textContent = "Play sample";
      btnPreview.disabled = true;
    } else {
      btnPreview.textContent = "Play sample";
      btnPreview.disabled = false;
    }
  }

  btnPreview.addEventListener("click", async () => {
    if (!requireModelsReady()) return;

    if (previewPlaying) {
      previewStoppedByUser = true;
      previewPlaying = false;
      player.stopPreview();
      setStatus("Preview stopped");
      syncPreviewButton();
      return;
    }

    if (previewLoading) return;

    previewStoppedByUser = false;
    previewLoading = true;
    syncPreviewButton();
    setStatus("Generating voice sample…");
    try {
      const data = await window.ttsApp.rpc("preview_voice", {
        voiceId: voiceSelect.value,
        emotion: emotionSelect.value,
      });
      if (!data?.audioWavBase64) {
        throw new Error("No audio returned from preview");
      }
      previewLoading = false;
      previewPlaying = true;
      setStatus("Playing sample…");
      syncPreviewButton();
      await player.playPreview(data.audioWavBase64);
      if (!previewStoppedByUser) {
        setStatus(`Sample (${data.duration.toFixed(1)}s)`);
      }
    } catch (e) {
      console.error(e);
      setStatus(`Preview failed: ${e.message}`);
    } finally {
      previewLoading = false;
      previewPlaying = false;
      syncPreviewButton();
    }
  });

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  $("#btn-dict-add").addEventListener("click", () => addDictRow());
  $("#btn-dict-save").addEventListener("click", async () => {
    try {
      userDictionary = collectDictionary();
      await window.ttsApp.rpc("save_dictionary", { entries: userDictionary });
      setStatus("Dictionary saved");
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, { isError: true });
    }
  });

  $("#btn-clear-done").addEventListener("click", () => {
    const keep = jobs.filter((j) => j.status !== "done" && j.status !== "cancelled");
    jobs.length = 0;
    jobs.push(...keep);
    renderJobs();
  });

  try {
    await window.ttsApp.rpc("ping");
    await refreshModelsPath();
    const status = await checkModelsInstalled();

    if (status.installed) {
      await onModelsReady();
    } else {
      setModelStatus("Setup required", "");
      setStatus("Download speech models to begin");
      showModelSetup(true);
      if (status.backboneReady || status.codecReady) {
        setModelDownloadError(
          "Some model files are present but incomplete. Click Download to finish."
        );
      }
    }
  } catch (e) {
    setModelStatus("Offline", "");
    setStatus(`Worker error: ${e.message}`, { isError: true });
    showModelSetup(true);
    setModelDownloadError(e.message);
  }
}

init();
