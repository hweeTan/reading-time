import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ttsApi } from "./api/ttsApp";
import { AudioPlayer, type PlayerUi } from "./audio/AudioPlayer";
import styles from "./App.module.css";
import { DictionaryView, type DictRow } from "./components/DictionaryView/DictionaryView";
import { Header } from "./components/Header/Header";
import { JobQueue } from "./components/JobQueue/JobQueue";
import { ModelSetup } from "./components/ModelSetup/ModelSetup";
import { PlayerFooter } from "./components/PlayerFooter/PlayerFooter";
import { SynthesizeView } from "./components/SynthesizeView/SynthesizeView";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useTtsEvents } from "./hooks/useTtsEvents";
import type { Job, StreamJob, TtsEvent, ViewName, Voice } from "./types/tts";
import {
  basename,
  slugify,
  streamJobTitle,
  stripUnwantedChars,
} from "./utils";

const PREF_OUTPUT_DIR = "outputDir";
const PREF_VOICE_ID = "voiceId";
const PREF_EMOTION = "emotion";
const STREAM_TEXT_DEBOUNCE_MS = 500;

let dictRowCounter = 0;
function newDictRow(key = "", value = ""): DictRow {
  return { id: `dict-${++dictRowCounter}`, key, value };
}

export default function App() {
  const [currentView, setCurrentView] = useState<ViewName>("synthesize");
  const [modelsReady, setModelsReady] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [modelsPath, setModelsPath] = useState("");
  const [modelStatusText, setModelStatusText] = useState("Connecting...");
  const [modelStatusClass, setModelStatusClass] = useState<
    "" | "ready" | "loading"
  >("");
  const [setupProgress, setSetupProgress] = useState({
    show: false,
    percent: 0,
    message: "Preparing…",
  });
  const [setupError, setSetupError] = useState("");
  const [downloadDisabled, setDownloadDisabled] = useState(false);
  const [modelDownloadRunning, setModelDownloadRunning] = useState(false);

  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useLocalStorage(PREF_VOICE_ID, "");
  const [emotion, setEmotion] = useLocalStorage(PREF_EMOTION, "storytelling");
  const [outputDir, setOutputDir] = useLocalStorage(PREF_OUTPUT_DIR, "");

  const [jobs, setJobs] = useState<Job[]>([]);
  const [footerStatus, setFooterStatus] = useState("Ready");
  const [footerError, setFooterError] = useState(false);

  const [dictRows, setDictRows] = useState<DictRow[]>([newDictRow()]);
  const [dictionaryLoaded, setDictionaryLoaded] = useState(false);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewStoppedByUser = useRef(false);

  const jobCounterRef = useRef(0);
  const streamJobRef = useRef<StreamJob | null>(null);
  const streamSourceTextRef = useRef<string | null>(null);
  const lastStreamPlaybackSync = useRef<{
    playing: boolean | null;
    chunk: number | null;
  }>({ playing: null, chunk: null });
  const streamTextChangeTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const streamRestartPendingRef = useRef(false);
  const pendingStreamAutoPlayRef = useRef(true);
  const playerRef = useRef<AudioPlayer | null>(null);
  const modelsReadyRef = useRef(false);
  /** Always-current textarea value for audio handlers (avoids stale closures). */
  const textRef = useRef(text);

  const setStatus = useCallback((msg: string, isError = false) => {
    setFooterStatus(msg);
    setFooterError(isError);
  }, []);

  const setInputText = useCallback((value: string) => {
    textRef.current = value;
    setText(value);
  }, []);

  const getSynthText = useCallback(() => {
    const cleaned = stripUnwantedChars(textRef.current).trim();
    return cleaned || null;
  }, []);

  const applyLiveSynthSettings = useCallback(
    (vId: string, emo: string) => {
      const stream = streamJobRef.current;
      const player = playerRef.current;
      if (stream?.status === "running") {
        const chunk = player?.getPlaybackChunkIndex() || 1;
        const playing = player?.wantsStreamPlayback() ?? false;
        const syncPlayback = player
          ? ttsApi.setJobPlayback(stream.id, playing, chunk)
          : Promise.resolve();
        syncPlayback
          .then(() => ttsApi.setJobSynthConfig(stream.id, vId, emo))
          .catch(() => { });
        return;
      }
      const runningJob = jobs.find((j) => j.status === "running");
      if (runningJob) {
        ttsApi
          .setJobSynthConfig(runningJob.id, vId, emo)
          .catch(() => { });
      }
    },
    [jobs]
  );

  const handleVoiceChange = useCallback(
    (id: string) => {
      setVoiceId(id);
      applyLiveSynthSettings(id, emotion);
    },
    [setVoiceId, emotion, applyLiveSynthSettings]
  );

  const handleEmotionChange = useCallback(
    (emo: string) => {
      setEmotion(emo);
      applyLiveSynthSettings(voiceId, emo);
    },
    [setEmotion, voiceId, applyLiveSynthSettings]
  );

  const loadVoices = useCallback(async () => {
    const { voices: list } = await ttsApi.listVoices();
    setVoices(list);
    const saved = localStorage.getItem(PREF_VOICE_ID);
    if (saved && list.some((v) => v.id === saved)) {
      setVoiceId(saved);
    } else if (list.length) {
      const def =
        list.find((v) => v.id === "Doan")?.id ?? list[0].id;
      setVoiceId(def);
    }
  }, [setVoiceId]);

  useEffect(() => {
    modelsReadyRef.current = modelsReady;
  }, [modelsReady]);

  const onModelsReady = useCallback(async () => {
    modelsReadyRef.current = true;
    setModelsReady(true);
    setShowSetup(false);
    setSetupError("");
    setSetupProgress((p) => ({ ...p, show: false }));
    setDownloadDisabled(false);
    setModelDownloadRunning(false);

    setModelStatusText("Loading model...");
    setModelStatusClass("loading");
    try {
      await ttsApi.warmup();
      await loadVoices();
      setModelStatusText("Ready");
      setModelStatusClass("ready");
      setStatus("Models ready");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setModelStatusText("Error");
      setModelStatusClass("");
      setStatus(`Model load failed: ${msg}`, true);
      modelsReadyRef.current = false;
      setModelsReady(false);
      setShowSetup(true);
      setSetupError(msg);
    }
  }, [loadVoices, setStatus]);

  const startModelDownload = useCallback(async () => {
    if (modelDownloadRunning || modelsReady) return;
    setModelDownloadRunning(true);
    setDownloadDisabled(true);
    setSetupError("");
    setSetupProgress({ show: true, percent: 0, message: "Starting download…" });
    setStatus("Downloading speech models…");

    try {
      const result = (await ttsApi.downloadModels()) as {
        status?: string;
      };
      if (result?.status === "already_installed") {
        await onModelsReady();
      }
    } catch (e) {
      if (!modelsReady) {
        const msg = e instanceof Error ? e.message : String(e);
        setSetupError(msg);
        setStatus(`Download failed: ${msg}`, true);
        setDownloadDisabled(false);
        setModelDownloadRunning(false);
      }
    }
  }, [modelDownloadRunning, modelsReady, onModelsReady, setStatus]);

  const handleModelEvent = useCallback(
    (event: TtsEvent) => {
      if (event.type === "model_download_started") {
        setSetupProgress({ show: true, percent: 0, message: "Downloading…" });
        return;
      }
      if (event.type === "model_download_phase") {
        const label = event.phase === "codec" ? "Codec" : "Voice model";
        setSetupProgress((p) => ({
          ...p,
          message: `Downloading ${label}…`,
        }));
        return;
      }
      if (event.type === "model_download_progress") {
        const pct = event.percent ?? 0;
        setSetupProgress({
          show: true,
          percent: pct,
          message: event.message || "Downloading…",
        });
        return;
      }
      if (event.type === "model_download_complete") {
        void onModelsReady();
        return;
      }
      if (event.type === "model_download_error") {
        setSetupError(event.message);
        setStatus(`Download failed: ${event.message}`, true);
        setDownloadDisabled(false);
        setModelDownloadRunning(false);
      }
    },
    [onModelsReady, setStatus]
  );

  const requireModelsReady = useCallback(() => {
    if (!modelsReadyRef.current) {
      alert("Download speech models first using the setup screen.");
      return false;
    }
    return true;
  }, []);

  const syncStreamPlaybackControl = useCallback(
    ({
      playing,
      playbackChunkIndex,
    }: {
      playing?: boolean;
      playbackChunkIndex?: number;
    } = {}) => {
      const streamJob = streamJobRef.current;
      const player = playerRef.current;
      if (!streamJob || streamJob.status !== "running" || !player) return;

      const isPlaying = playing ?? player.wantsStreamPlayback();
      const chunk = playbackChunkIndex ?? player.getPlaybackChunkIndex();

      if (
        lastStreamPlaybackSync.current.playing === isPlaying &&
        lastStreamPlaybackSync.current.chunk === chunk
      ) {
        return;
      }
      lastStreamPlaybackSync.current = { playing: isPlaying, chunk };

      ttsApi
        .setJobPlayback(streamJob.id, isPlaying, chunk)
        .catch(() => { });
    },
    []
  );

  const failStreamJob = useCallback(
    (message: string) => {
      const streamJob = streamJobRef.current;
      const player = playerRef.current;
      if (streamJob && player) {
        player.endSession(streamJob.id, { reason: "error" });
        streamJobRef.current = null;
      }
      streamSourceTextRef.current = null;
      setStatus(`Error: ${message}`, true);
    },
    [setStatus]
  );

  const cancelActiveStream = useCallback(async () => {
    const streamJob = streamJobRef.current;
    if (streamJob?.status === "running") {
      syncStreamPlaybackControl({ playing: false, playbackChunkIndex: 1 });
      try {
        await ttsApi.cancelJob(streamJob.id);
      } catch {
        /* ignore */
      }
    }
    streamJobRef.current = null;
    streamSourceTextRef.current = null;
    lastStreamPlaybackSync.current = { playing: null, chunk: null };
    playerRef.current?.reset();
  }, [syncStreamPlaybackControl]);

  const clearAndCancelStream = useCallback((): boolean => {
    const hadPlayback =
      streamSourceTextRef.current !== null ||
      streamJobRef.current?.status === "running" ||
      Boolean(playerRef.current?.session);

    if (!hadPlayback) return false;

    void cancelActiveStream();
    return true;
  }, [cancelActiveStream]);

  const stopStreamPlayback = useCallback(() => {
    clearAndCancelStream();
  }, [clearAndCancelStream]);

  const startStreamPlayback = useCallback(
    async ({ autoPlay = true }: { autoPlay?: boolean } = {}) => {
      if (!requireModelsReady()) return false;

      const synthText = getSynthText();
      if (!synthText) {
        alert("Enter some text first.");
        return true;
      }

      const player = playerRef.current;
      if (!player) return false;

      await cancelActiveStream();

      const id = `stream-${++jobCounterRef.current}`;
      const title = streamJobTitle(synthText);
      streamJobRef.current = { id, status: "running", title };
      streamSourceTextRef.current = synthText;
      lastStreamPlaybackSync.current = { playing: null, chunk: null };

      player.beginSession(id, { title, autoPlayOnChunk: autoPlay });
      setStatus(autoPlay ? `Playing: ${title}` : `Ready: ${title}`);

      try {
        await ttsApi.startJob({
          jobId: id,
          text: synthText,
          saveOutput: false,
          voiceId,
          emotion,
          maxChunkChars: 350,
        });
        syncStreamPlaybackControl({
          playing: autoPlay,
          playbackChunkIndex: 1,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failStreamJob(msg);
      }
      return true;
    },
    [
      requireModelsReady,
      getSynthText,
      syncStreamPlaybackControl,
      voiceId,
      emotion,
      failStreamJob,
      setStatus,
      cancelActiveStream,
    ]
  );

  const handleStreamTextChange = useCallback(() => {
    if (!streamRestartPendingRef.current) return;
    streamRestartPendingRef.current = false;

    const current = getSynthText();
    if (!current) return;

    void startStreamPlayback({ autoPlay: pendingStreamAutoPlayRef.current });
  }, [getSynthText, startStreamPlayback]);

  const failJob = useCallback(
    (jobId: string, message: string) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "error" as const, error: message }
            : j
        )
      );
      ttsApi.cancelJob(jobId).catch(() => { });
      setStatus(`Error: ${message}`, true);
    },
    [setStatus]
  );

  const enqueueJob = useCallback(
    async (jobText: string, title: string) => {
      if (!requireModelsReady()) return;

      const dir = outputDir.trim();
      if (!dir) {
        alert("Choose an output folder first.");
        return;
      }

      const id = `job-${++jobCounterRef.current}`;
      const filename = `${slugify(title)}-${id}.wav`;
      const outputPath = `${dir}/${filename}`;

      const job: Job = {
        id,
        title: title || `Job ${jobCounterRef.current}`,
        status: "queued",
        progress: 0,
        outputPath,
      };
      setJobs((prev) => [job, ...prev]);

      try {
        // Worker runs one job at a time; stop live playback so file synthesis can start.
        await cancelActiveStream();
        await ttsApi.startJob({
          jobId: id,
          text: stripUnwantedChars(jobText),
          outputPath,
          saveOutput: true,
          voiceId,
          emotion,
          maxChunkChars: 350,
        });
        setStatus(`Queued: ${job.title}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failJob(id, msg);
      }
    },
    [
      requireModelsReady,
      outputDir,
      voiceId,
      emotion,
      failJob,
      setStatus,
      cancelActiveStream,
    ]
  );

  const importFiles = useCallback(
    async (paths: string[]) => {
      for (const filePath of paths) {
        setStatus(`Importing ${basename(filePath)}…`);
        try {
          const { text: extracted } = await ttsApi.extractText(filePath);
          const title = basename(filePath);
          await enqueueJob(extracted, title);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus(`Import failed: ${msg}`, true);
        }
      }
    },
    [enqueueJob, setStatus]
  );

  const handleStreamEvent = useCallback(
    (event: TtsEvent & { jobId?: string }) => {
      const streamJob = streamJobRef.current;
      const player = playerRef.current;
      if (!streamJob || !player || event.jobId !== streamJob.id) return false;
      if (streamJob.status === "error" || streamJob.status === "cancelled") {
        return true;
      }
      if (streamJob.status !== "running") {
        return false;
      }

      if (event.type === "chunks_truncated") {
        player.truncateFromChunk(event.fromChunkIndex ?? 1);
        setStatus(`Regenerating from chunk ${event.fromChunkIndex ?? 1}…`);
      } else if (event.type === "chunk_audio" && "audioWavBase64" in event && event.audioWavBase64) {
        if (event.totalChunks) {
          player.setStreamPlan(streamJob.id, {
            totalChunks: event.totalChunks,
          });
        }
        player
          .appendChunk(streamJob.id, event.audioWavBase64, {
            chunkIndex: event.chunkIndex ?? 0,
            totalChunks: event.totalChunks,
            duration: event.duration,
            sampleRate: event.sampleRate,
          })
          .catch((e) => console.error("Chunk decode failed", e));
        if (streamJob.status === "running") {
          setStatus(`Playing: ${streamJob.title}`);
        }
      } else if (event.type === "job_complete") {
        streamJob.status = "done";
        player.endSession(streamJob.id, { reason: "ended" });
        streamJobRef.current = null;
        if (getSynthText() === streamSourceTextRef.current) {
          setStatus("Playback finished");
        }
      } else if (event.type === "job_error") {
        streamJob.status = "error";
        failStreamJob(event.message);
      } else if (event.type === "job_cancelled") {
        streamJob.status = "cancelled";
        player.endSession(streamJob.id, { reason: "cancelled" });
        streamJobRef.current = null;
        streamSourceTextRef.current = null;
        setStatus("Playback cancelled");
      } else if (event.type === "job_started") {
        if (event.totalChunks) {
          player.setStreamPlan(streamJob.id, {
            totalChunks: event.totalChunks,
          });
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
    },
    [getSynthText, failStreamJob, setStatus, syncStreamPlaybackControl]
  );

  const handleTtsEvent = useCallback(
    (event: TtsEvent) => {
      if (event.type?.startsWith("model_download")) {
        handleModelEvent(event);
        return;
      }

      if ("jobId" in event && event.jobId && handleStreamEvent(event)) {
        return;
      }

      if (event.type === "model_loading") {
        setModelStatusText("Loading model…");
        setModelStatusClass("loading");
        return;
      }
      if (event.type === "model_ready") {
        setModelStatusText("Model ready");
        setModelStatusClass("ready");
        return;
      }

      const jobId = "jobId" in event ? event.jobId : undefined;
      if (!jobId) return;

      setJobs((prev) => {
        const job = prev.find((j) => j.id === jobId);
        if (!job || job.status === "error" || job.status === "cancelled") {
          return prev;
        }

        let next = [...prev];
        const idx = next.findIndex((j) => j.id === jobId);
        const j = { ...next[idx] };

        if (event.type === "job_started") {
          j.status = "running";
          j.progress = 0;
          j.totalChunks = event.totalChunks || 0;
          setStatus(`Generating: ${j.title}`);
        } else if (
          event.type === "chunk_started" &&
          j.status === "running"
        ) {
          const total = event.totalChunks || j.totalChunks;
          if (total) {
            j.progress = (event.chunkIndex - 1) / total;
          }
        } else if (event.type === "chunk_done" && j.status === "running") {
          const total = event.totalChunks || j.totalChunks;
          if (total) {
            j.progress = event.chunkIndex / total;
          }
        } else if (event.type === "job_complete") {
          j.status = "done";
          j.progress = 1;
          j.outputPath = event.outputPath;
          setStatus(`Done: ${basename(event.outputPath ?? "")}`);
        } else if (event.type === "job_error") {
          failJob(jobId, event.message);
          return prev;
        } else if (event.type === "job_cancelled") {
          j.status = "cancelled";
          setStatus(`Cancelled: ${j.title}`);
        } else if (event.type === "warning") {
          console.warn(event.message);
          return prev;
        } else {
          return prev;
        }

        next[idx] = j;
        return next;
      });
    },
    [handleModelEvent, handleStreamEvent, failJob, setStatus]
  );

  useTtsEvents(handleTtsEvent);

  const loadDictionary = useCallback(async () => {
    const data = await ttsApi.getDictionary();
    const entries = data.userDictionary || {};
    const rows = Object.entries(entries);
    if (rows.length === 0) {
      setDictRows([newDictRow()]);
    } else {
      setDictRows(rows.map(([k, v]) => newDictRow(k, v)));
    }
    setDictionaryLoaded(true);
  }, []);

  useEffect(() => {
    if (currentView === "settings" && !dictionaryLoaded) {
      loadDictionary().catch((e) =>
        setStatus(
          `Dictionary: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }
  }, [currentView, dictionaryLoaded, loadDictionary, setStatus]);

  const bindPlayerHandlers = useCallback(
    (player: AudioPlayer) => {
      player.onPlayRequest = () => {
        const synthText = getSynthText();
        if (
          synthText &&
          streamSourceTextRef.current !== null &&
          synthText !== streamSourceTextRef.current
        ) {
          void startStreamPlayback({ autoPlay: true });
          return true;
        }
        if (player.session?.jobRunning || player.knownDurationSec > 0) {
          return false;
        }
        void startStreamPlayback();
        return true;
      };

      player.onPlaybackControl = ({ playing, playbackChunkIndex }) => {
        syncStreamPlaybackControl({ playing, playbackChunkIndex });
      };

      player.onStateChange = (state) => {
        if (
          state === "buffering" &&
          streamJobRef.current?.status === "running"
        ) {
          setStatus(`Buffering: ${streamJobRef.current.title}…`);
        }
      };
    },
    [getSynthText, startStreamPlayback, syncStreamPlaybackControl, setStatus]
  );

  const bindPlayerHandlersRef = useRef(bindPlayerHandlers);
  bindPlayerHandlersRef.current = bindPlayerHandlers;

  const handlePlayerUi = useCallback((ui: PlayerUi) => {
    // Recreate after React Strict Mode remount (footer DOM refs are new).
    playerRef.current?.reset();
    const player = new AudioPlayer(ui);
    playerRef.current = player;

    const savedMute = localStorage.getItem("livePlaybackMuted");
    player.setInitialMuted(savedMute === null ? true : savedMute !== "0");

    bindPlayerHandlersRef.current(player);
    player.syncUi();
  }, []);

  const handlePlayerPlayClick = useCallback(() => {
    playerRef.current?.handlePlayClick();
  }, []);

  const handlePlayerMuteClick = useCallback(() => {
    playerRef.current?.handleMuteClick();
  }, []);

  const handlePlayerSeekInput = useCallback((value: number) => {
    playerRef.current?.handleSeekInput(value);
  }, []);

  const handlePlayerSeekChange = useCallback(() => {
    playerRef.current?.handleSeekChange();
  }, []);

  // Re-bind play/stream handlers when deps change without recreating AudioPlayer.
  useEffect(() => {
    const player = playerRef.current;
    if (player) bindPlayerHandlersRef.current(player);
  }, [bindPlayerHandlers]);

  const onModelsReadyRef = useRef(onModelsReady);
  onModelsReadyRef.current = onModelsReady;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (typeof window.ttsApp === "undefined") {
          throw new Error(
            "Electron bridge missing — use pnpm run dev from electron/, not a browser tab."
          );
        }
        setModelStatusText("Checking models…");
        const status = await ttsApi.getBootstrap();
        if (cancelled) return;

        setModelsPath(status.modelsPath || status.path || "");

        if (status.installed) {
          await onModelsReadyRef.current();
        } else {
          setModelStatusText("Setup required");
          setModelStatusClass("");
          setStatus("Download speech models to begin");
          setShowSetup(true);
          if (status.backboneReady || status.codecReady) {
            setSetupError(
              "Some model files are present but incomplete. Click Download to finish."
            );
          }
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setModelStatusText("Offline");
        setModelStatusClass("");
        setStatus(`Worker error: ${msg}`, true);
        setShowSetup(true);
        setSetupError(msg);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setStatus]);

  useEffect(() => {
    document.body.classList.toggle("appLocked", showSetup);
    return () => {
      document.body.classList.remove("appLocked");
    };
  }, [showSetup]);

  const handleStreamTextChangeRef = useRef(handleStreamTextChange);
  handleStreamTextChangeRef.current = handleStreamTextChange;

  const handleTextChange = useCallback(
    (value: string) => {
      setInputText(value);
      const cleaned = stripUnwantedChars(value).trim() || null;
      const source = streamSourceTextRef.current;
      const hadPlayback =
        source !== null ||
        streamJobRef.current?.status === "running" ||
        Boolean(playerRef.current?.session);

      if (hadPlayback && cleaned !== source) {
        streamRestartPendingRef.current = true;
        pendingStreamAutoPlayRef.current =
          playerRef.current?.wantsStreamPlayback() ?? false;
        if (clearAndCancelStream()) {
          setStatus(
            cleaned
              ? "Text changed — restarting…"
              : "Playback stopped — text is empty"
          );
        }
      }

      if (streamTextChangeTimer.current) {
        clearTimeout(streamTextChangeTimer.current);
      }
      streamTextChangeTimer.current = setTimeout(() => {
        handleStreamTextChangeRef.current();
      }, STREAM_TEXT_DEBOUNCE_MS);
    },
    [setInputText, clearAndCancelStream, setStatus]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length === 1 && files[0].type.startsWith("text/")) {
        handleTextChange(await files[0].text());
        return;
      }
      const paths = files
        .map((f) => ttsApi.getPathForFile(f))
        .filter(Boolean);
      if (paths.length) await importFiles(paths);
    },
    [importFiles, handleTextChange]
  );

  const handlePreview = useCallback(async () => {
    if (!requireModelsReady()) return;
    if (!voiceId) {
      setStatus("Select a voice first.", true);
      return;
    }
    const player = playerRef.current;
    if (!player) {
      setStatus("Audio player not ready — try again.", true);
      return;
    }

    if (previewPlaying) {
      previewStoppedByUser.current = true;
      setPreviewPlaying(false);
      player.stopPreview();
      setStatus("Preview stopped");
      return;
    }
    if (previewLoading) return;

    previewStoppedByUser.current = false;
    setPreviewLoading(true);
    setStatus("Generating voice sample…");
    try {
      const data = await ttsApi.previewVoice(voiceId, emotion);
      if (!data?.audioWavBase64) {
        throw new Error("No audio returned from preview");
      }
      setPreviewLoading(false);
      setPreviewPlaying(true);
      setStatus("Playing sample…");
      await player.playPreview(data.audioWavBase64);
      if (!previewStoppedByUser.current) {
        setStatus(`Sample (${data.duration.toFixed(1)}s)`);
      }
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Preview failed: ${msg}`);
    } finally {
      setPreviewLoading(false);
      setPreviewPlaying(false);
    }
  }, [
    requireModelsReady,
    previewPlaying,
    previewLoading,
    voiceId,
    emotion,
    setStatus,
  ]);

  const previewLabel = previewPlaying
    ? "Stop sample"
    : "Play sample";

  return (
    <>
      {showSetup ? (
        <ModelSetup
          modelsPath={modelsPath}
          showProgress={setupProgress.show}
          progressPercent={setupProgress.percent}
          progressMessage={setupProgress.message}
          error={setupError}
          downloadDisabled={downloadDisabled}
          onDownload={() => void startModelDownload()}
          onOpenFolder={() => void ttsApi.openModelsFolder()}
        />
      ) : null}

      <div className={styles.app}>
        <Header
          currentView={currentView}
          modelStatusText={modelStatusText}
          modelStatusClass={modelStatusClass}
          onViewChange={setCurrentView}
        />

        <div className={styles.main}>
          <div
            className={
              currentView === "synthesize"
                ? styles.synthesizeActive
                : styles.synthesizeView
            }
          >
            <SynthesizeView
              text={text}
              onTextChange={handleTextChange}
              dragOver={dragOver}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void handleDrop(e)}
              voices={voices}
              voiceId={voiceId}
              onVoiceChange={handleVoiceChange}
              emotion={emotion}
              onEmotionChange={handleEmotionChange}
              outputDir={outputDir}
              onBrowseOutput={async () => {
                const dir = await ttsApi.pickOutputDirectory(
                  outputDir.trim() || undefined
                );
                if (dir) setOutputDir(dir);
              }}
              onImport={async () => {
                const paths = await ttsApi.pickInputFiles();
                if (paths.length) await importFiles(paths);
              }}
              onGenerate={async () => {
                if (!requireModelsReady()) return;
                const cleaned = getSynthText();
                if (!cleaned) {
                  alert("Enter some text first.");
                  return;
                }
                await enqueueJob(cleaned, streamJobTitle(cleaned));
              }}
              previewLabel={previewLabel}
              previewDisabled={previewLoading || !modelsReady || !voiceId}
              onPreview={() => void handlePreview()}
            />
            <JobQueue
              jobs={jobs}
              onCancel={(jobId) => {
                ttsApi.cancelJob(jobId).catch(() => { });
                setJobs((prev) => {
                  const job = prev.find((j) => j.id === jobId);
                  if (job) setStatus(`Cancelled: ${job.title}`);
                  return prev.map((j) =>
                    j.id === jobId ? { ...j, status: "cancelled" } : j
                  );
                });
              }}
              onReveal={(path) => void ttsApi.showItemInFolder(path)}
              onClearDone={() => {
                setJobs((prev) =>
                  prev.filter(
                    (j) => j.status !== "done" && j.status !== "cancelled"
                  )
                );
              }}
            />
          </div>

          <div
            className={
              currentView === "settings"
                ? styles.settingsActive
                : styles.settingsView
            }
          >
            <DictionaryView
              rows={dictRows}
              onRowChange={(id, field, val) => {
                setDictRows((prev) =>
                  prev.map((r) =>
                    r.id === id ? { ...r, [field]: val } : r
                  )
                );
              }}
              onAddRow={() => setDictRows((prev) => [...prev, newDictRow()])}
              onRemoveRow={(id) =>
                setDictRows((prev) => prev.filter((r) => r.id !== id))
              }
              onSave={async () => {
                try {
                  const entries: Record<string, string> = {};
                  for (const row of dictRows) {
                    const k = row.key.trim();
                    const v = row.value.trim();
                    if (k) entries[k] = v;
                  }
                  await ttsApi.saveDictionary(entries);
                  setStatus("Dictionary saved");
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  setStatus(`Save failed: ${msg}`, true);
                }
              }}
            />
          </div>
        </div>

        <PlayerFooter
          status={footerStatus}
          isError={footerError}
          onUiReady={handlePlayerUi}
          onPlayClick={handlePlayerPlayClick}
          onMuteClick={handlePlayerMuteClick}
          onSeekInput={handlePlayerSeekInput}
          onSeekChange={handlePlayerSeekChange}
        />
      </div>
    </>
  );
}
