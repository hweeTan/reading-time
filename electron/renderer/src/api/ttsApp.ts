import type {
  CheckModelsResult,
  PreviewVoiceResult,
  Voice,
} from "../types/tts";

function bridge() {
  if (typeof window === "undefined" || !window.ttsApp) {
    throw new Error(
      "ReadingTime backend is unavailable. Run the Electron app with npm run dev from electron/ (do not open the Vite URL in a browser)."
    );
  }
  return window.ttsApp;
}

export const ttsApi = {
  ping: () => bridge().rpc("ping"),
  checkModels: () => bridge().rpc("check_models") as Promise<CheckModelsResult>,
  warmup: () => bridge().rpc("warmup"),
  downloadModels: () => bridge().rpc("download_models"),
  listVoices: () =>
    bridge().rpc("list_voices") as Promise<{ voices: Voice[] }>,
  getDictionary: () =>
    bridge().rpc("get_dictionary") as Promise<{
      userDictionary: Record<string, string>;
    }>,
  saveDictionary: (entries: Record<string, string>) =>
    bridge().rpc("save_dictionary", { entries }),
  extractText: (path: string) =>
    bridge().rpc("extract_text", { path }) as Promise<{ text: string }>,
  previewVoice: (voiceId: string, emotion: string) =>
    bridge().rpc("preview_voice", { voiceId, emotion }) as Promise<PreviewVoiceResult>,
  startJob: (payload: Record<string, unknown>) =>
    bridge().rpc("start_job", payload),
  cancelJob: (jobId: string) => bridge().rpc("cancel_job", { jobId }),
  setJobSynthConfig: (jobId: string, voiceId: string, emotion: string) =>
    bridge().rpc("set_job_synth_config", { jobId, voiceId, emotion }),
  setJobPlayback: (
    jobId: string,
    playing: boolean,
    playbackChunkIndex: number
  ) =>
    bridge().rpc("set_job_playback", {
      jobId,
      playing,
      playbackChunkIndex,
    }),
  getPathForFile: (file: File) => bridge().getPathForFile(file),
  pickInputFiles: () => bridge().pickInputFiles(),
  pickOutputDirectory: (defaultPath?: string) =>
    bridge().pickOutputDirectory(defaultPath),
  showItemInFolder: (p: string) => bridge().showItemInFolder(p),
  getModelsPath: () => bridge().getModelsPath(),
  openModelsFolder: () => bridge().openModelsFolder(),
  onEvent: (handler: (event: import("../types/tts").TtsEvent) => void) =>
    bridge().onEvent(handler),
};
