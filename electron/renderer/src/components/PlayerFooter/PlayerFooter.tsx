import { useEffect, useRef } from "react";
import type { PlayerUi } from "../../audio/AudioPlayer";
import styles from "./PlayerFooter.module.css";
import ui from "../../styles/ui.module.css";

interface PlayerFooterProps {
  status: string;
  isError?: boolean;
  onUiReady: (ui: PlayerUi) => void;
  onPlayClick: () => void;
  onMuteClick: () => void;
  onSeekInput: (value: number) => void;
  onSeekChange: () => void;
}

export function PlayerFooter({
  status,
  isError,
  onUiReady,
  onPlayClick,
  onMuteClick,
  onSeekInput,
  onSeekChange,
}: PlayerFooterProps) {
  const btnPlayRef = useRef<HTMLButtonElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const chunksRef = useRef<HTMLSpanElement>(null);
  const btnMuteRef = useRef<HTMLButtonElement>(null);
  const onUiReadyRef = useRef(onUiReady);
  onUiReadyRef.current = onUiReady;

  useEffect(() => {
    const btnPlay = btnPlayRef.current;
    const seek = seekRef.current;
    const timeLabel = timeRef.current;
    const chunksLabel = chunksRef.current;
    const btnMute = btnMuteRef.current;
    if (!btnPlay || !seek || !timeLabel || !chunksLabel || !btnMute) {
      return;
    }
    onUiReadyRef.current({
      btnPlay,
      seek,
      timeLabel,
      chunksLabel,
      btnMute,
      muteIcon: btnMute.querySelector(".mute-icon path"),
      muteLabel: btnMute.querySelector(".mute-label"),
    });
  }, []);

  return (
    <footer
      className={`${styles.footer} ${isError ? styles.footerError : ""}`}
    >
      <div className={styles.playerBar} aria-label="Audio playback">
        <button
          type="button"
          ref={btnPlayRef}
          className={styles.playerBtn}
          aria-label="Play"
          onClick={onPlayClick}
        >
          ▶
        </button>
        <input
          type="range"
          ref={seekRef}
          className={styles.playerSeek}
          min={0}
          max={1}
          defaultValue={0}
          step={0.05}
          disabled
          aria-label="Seek"
          onInput={(e) =>
            onSeekInput(parseFloat(e.currentTarget.value) || 0)
          }
          onChange={onSeekChange}
        />
        <span ref={timeRef} className={styles.playerTime}>
          0:00 / 0:00
        </span>
        <span
          ref={chunksRef}
          className={styles.playerChunks}
          aria-label="Chunk progress"
        />
        <button
          type="button"
          ref={btnMuteRef}
          className={`${styles.playerMute} is-muted`}
          aria-pressed
          title="Muted — click to unmute"
          onClick={onMuteClick}
        >
          <svg
            className={`mute-icon ${styles.muteIcon}`}
            viewBox="0 0 24 24"
            width={16}
            height={16}
            aria-hidden
          >
            <path
              fill="currentColor"
              d="M16.5 12a4.5 4.5 0 0 0-1.9-3.7l1.4-1.4A6.5 6.5 0 0 1 18.5 12c0 1.8-.7 3.4-1.9 4.6l-1.4-1.4A4.5 4.5 0 0 0 16.5 12ZM3 9v6h4l5 5V4L7 9H3zm14.3 2.3 1.4 1.4L22.4 9l-3.7-3.7-1.4 1.4L19.6 9l-2.3 2.3z"
            />
          </svg>
          <span className="mute-label">Muted</span>
        </button>
      </div>
      <span
        className={
          isError
            ? `${ui.muted} ${styles.footerStatusError}`
            : `${ui.muted} ${styles.footerStatus}`
        }
      >
        {status}
      </span>
    </footer>
  );
}
