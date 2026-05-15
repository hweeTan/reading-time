import ui from "../../styles/ui.module.css";
import styles from "./ModelSetup.module.css";

interface ModelSetupProps {
  modelsPath: string;
  showProgress: boolean;
  progressPercent: number;
  progressMessage: string;
  error: string;
  downloadDisabled: boolean;
  onDownload: () => void;
  onOpenFolder: () => void;
}

export function ModelSetup({
  modelsPath,
  showProgress,
  progressPercent,
  progressMessage,
  error,
  downloadDisabled,
  onDownload,
  onOpenFolder,
}: ModelSetupProps) {
  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <h2>Download speech models</h2>
        <p className={ui.muted}>
          A one-time download (~500&nbsp;MB) is required for Vietnamese
          text-to-speech. Models are stored on your computer and work offline
          after that.
        </p>
        {modelsPath ? (
          <p className={ui.mutedSmall}>Storage: {modelsPath}</p>
        ) : null}
        {showProgress ? (
          <div className={styles.progressSection}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBar}
                style={{ width: `${Math.round(progressPercent * 100)}%` }}
              />
            </div>
            <p className={ui.mutedSmall}>{progressMessage}</p>
          </div>
        ) : null}
        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={`${ui.row} ${styles.actions}`}>
          <button
            type="button"
            className={`${ui.btn} ${ui.primary}`}
            disabled={downloadDisabled}
            onClick={onDownload}
          >
            Download models
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.ghost}`}
            onClick={onOpenFolder}
          >
            Open folder
          </button>
        </div>
      </div>
    </div>
  );
}
