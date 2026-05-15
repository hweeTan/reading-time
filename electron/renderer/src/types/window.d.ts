import type { BootstrapResult, TtsEvent } from './tts'

export interface TtsAppBridge {
  getPathForFile(file: File): string
  pickInputFiles(): Promise<string[]>
  pickOutputFile(name: string): Promise<string | null>
  pickOutputDirectory(defaultPath?: string): Promise<string | null>
  showItemInFolder(p: string): Promise<void>
  getModelsPath(): Promise<string>
  openModelsFolder(): Promise<void>
  getBootstrap(): Promise<BootstrapResult>
  rpc(cmd: string, payload?: unknown): Promise<unknown>
  onEvent(handler: (event: TtsEvent) => void): () => void
}

declare global {
  interface Window {
    ttsApp: TtsAppBridge
  }
}

export {}
