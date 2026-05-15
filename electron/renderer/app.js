/** @typedef {{ id: string, title: string, status: string, progress: number, outputPath?: string, error?: string }} Job */

const $ = (sel) => document.querySelector(sel);

const textInput = $("#text-input");
const dropZone = $("#drop-zone");
const voiceSelect = $("#voice-select");
const emotionSelect = $("#emotion-select");
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

function bindSynthPreferences() {
  voiceSelect.addEventListener("change", () => {
    if (voiceSelect.value) localStorage.setItem(PREF_VOICE_ID, voiceSelect.value);
  });
  emotionSelect.addEventListener("change", () => {
    if (emotionSelect.value) localStorage.setItem(PREF_EMOTION, emotionSelect.value);
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
      player.endSession(job.id, { reason: "cancelled" });
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
  player.endSession(job.id, { reason: "error" });
  window.ttsApp.rpc("cancel_job", { jobId: job.id }).catch(() => {});
  setStatus(`Error: ${message}`, { isError: true });
  renderJobs();
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

function handleTtsEvent(event) {
  if (event.type?.startsWith("model_download")) {
    handleModelEvent(event);
    return;
  }

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
    player.beginSession(job.id, {
      title: job.title,
      estimatedTotalSec: 0,
    });
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
  } else if (event.type === "chunk_audio" && job.status === "running" && event.audioWavBase64) {
    player
      .appendChunk(job.id, event.audioWavBase64, {
        chunkIndex: event.chunkIndex,
        totalChunks: event.totalChunks,
        duration: event.duration,
        totalDuration: event.totalDuration,
        sampleRate: event.sampleRate,
      })
      .catch((e) => console.error("Chunk decode failed", e));
  } else if (event.type === "job_complete") {
    job.status = "done";
    job.progress = 1;
    job.outputPath = event.outputPath;
    player
      .loadFile(job.id, event.outputPath, event.duration)
      .then(() => player.endSession(job.id, { reason: "ended" }))
      .catch((e) => console.error("Load output failed", e));
    setStatus(`Done: ${basename(event.outputPath)}`);
  } else if (event.type === "job_error") {
    failJob(job, event.message);
    return;
  } else if (event.type === "job_cancelled") {
    job.status = "cancelled";
    player.endSession(job.id, { reason: "cancelled" });
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
    const cleaned = stripUnwantedChars(textInput.value).trim();
    if (!cleaned) {
      alert("Enter some text first.");
      return;
    }
    if (cleaned !== textInput.value) {
      textInput.value = cleaned;
    }
    const title = cleaned.slice(0, 48).replace(/\s+/g, " ") + (cleaned.length > 48 ? "…" : "");
    await enqueueJob(cleaned, title);
  });

  $("#btn-preview").addEventListener("click", async () => {
    if (!requireModelsReady()) return;
    const btn = $("#btn-preview");
    btn.disabled = true;
    setStatus("Generating voice sample…");
    try {
      const data = await window.ttsApp.rpc("preview_voice", {
        voiceId: voiceSelect.value,
        emotion: emotionSelect.value,
      });
      if (!data?.audioWavBase64) {
        throw new Error("No audio returned from preview");
      }
      setStatus("Playing sample…");
      $("#btn-stop-preview").disabled = false;
      await player.playPreview(data.audioWavBase64);
      $("#btn-stop-preview").disabled = true;
      setStatus(`Sample (${data.duration.toFixed(1)}s)`);
    } catch (e) {
      console.error(e);
      setStatus(`Preview failed: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $("#btn-stop-preview").addEventListener("click", () => {
    player.stopPreview();
    $("#btn-stop-preview").disabled = true;
    setStatus("Preview stopped");
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
