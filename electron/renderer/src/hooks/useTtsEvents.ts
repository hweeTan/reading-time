import { useEffect } from 'react'
import type { TtsEvent } from '../types/tts'
import { ttsApi } from '../api/ttsApp'

export function useTtsEvents(handler: (event: TtsEvent) => void) {
  useEffect(() => {
    return ttsApi.onEvent(handler)
  }, [handler])
}
