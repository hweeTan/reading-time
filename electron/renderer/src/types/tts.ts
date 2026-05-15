export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface Job {
  id: string;
  title: string;
  status: JobStatus;
  progress: number;
  outputPath?: string;
  error?: string;
  totalChunks?: number;
}

export interface StreamJob {
  id: string;
  status: string;
  title: string;
}

export interface Voice {
  id: string;
  description: string;
}

export type ViewName = "synthesize" | "settings";

export type ModelEvent =
  | { type: "model_download_started" }
  | { type: "model_download_phase"; phase: string }
  | { type: "model_download_progress"; percent?: number; message?: string }
  | { type: "model_download_complete" }
  | { type: "model_download_error"; message: string };

export type JobEvent =
  | { type: "model_loading" }
  | { type: "model_ready" }
  | { type: "job_started"; jobId: string; totalChunks?: number }
  | { type: "chunk_started"; jobId: string; chunkIndex: number; totalChunks?: number }
  | { type: "chunk_done"; jobId: string; chunkIndex: number; totalChunks?: number }
  | {
      type: "chunk_audio";
      jobId: string;
      chunkIndex: number;
      totalChunks?: number;
      duration?: number;
      sampleRate?: number;
      audioWavBase64?: string;
    }
  | { type: "job_complete"; jobId: string; outputPath?: string }
  | { type: "job_error"; jobId: string; message: string }
  | { type: "job_cancelled"; jobId: string }
  | { type: "warning"; message: string };

export type TtsEvent = ModelEvent | JobEvent;

export interface CheckModelsResult {
  installed: boolean;
  backboneReady?: boolean;
  codecReady?: boolean;
}

export interface PreviewVoiceResult {
  audioWavBase64: string;
  duration: number;
}
