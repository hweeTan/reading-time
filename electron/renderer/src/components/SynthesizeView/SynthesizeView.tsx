import type { Voice } from "../../types/tts";
import ui from "../../styles/ui.module.css";
import styles from "./SynthesizeView.module.css";

interface SynthesizeViewProps {
  text: string;
  onTextChange: (text: string) => void;
  dragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  voices: Voice[];
  voiceId: string;
  onVoiceChange: (id: string) => void;
  emotion: string;
  onEmotionChange: (emotion: string) => void;
  outputDir: string;
  onBrowseOutput: () => void;
  onImport: () => void;
  onGenerate: () => void;
  previewLabel: string;
  previewDisabled: boolean;
  onPreview: () => void;
}

export function SynthesizeView({
  text,
  onTextChange,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  voices,
  voiceId,
  onVoiceChange,
  emotion,
  onEmotionChange,
  outputDir,
  onBrowseOutput,
  onImport,
  onGenerate,
  previewLabel,
  previewDisabled,
  onPreview,
}: SynthesizeViewProps) {
  return (
    <>
      <section className={`${ui.panel} ${styles.panelInput}`}>
        <h2>Text</h2>
        <div
          className={dragOver ? styles.dropZoneDragover : styles.dropZone}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <p>
            Type, paste, or drop <strong>.txt</strong>, <strong>.md</strong>,{" "}
            <strong>.docx</strong>, <strong>.pdf</strong>
          </p>
        </div>
        <textarea
          className={ui.textarea}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Nhập hoặc dán văn bản tiếng Việt…"
          rows={10}
        />
        <div className={ui.row}>
          <button
            type="button"
            className={`${ui.btn} ${ui.secondary}`}
            onClick={onImport}
          >
            Import files…
          </button>
        </div>
      </section>

      <section className={`${ui.panel} ${styles.panelVoice}`}>
        <h2>Voice &amp; output</h2>
        <div className={ui.field}>
          <span>Voice</span>
          <div className={styles.voiceRow}>
            <select
              className={ui.select}
              value={voiceId}
              onChange={(e) => onVoiceChange(e.target.value)}
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} — {v.description}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary} ${styles.previewBtn}`}
              disabled={previewDisabled}
              onClick={onPreview}
            >
              {previewLabel}
            </button>
          </div>
        </div>
        <label className={ui.field}>
          <span>Emotion</span>
          <select
            className={ui.select}
            value={emotion}
            onChange={(e) => onEmotionChange(e.target.value)}
          >
            <option value="storytelling">Storytelling</option>
            <option value="natural">Natural</option>
          </select>
        </label>
        <label className={ui.field}>
          <span>Output folder</span>
          <div className={ui.row}>
            <input
              type="text"
              className={ui.textField}
              value={outputDir}
              readOnly
              placeholder="Choose folder…"
            />
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary}`}
              onClick={onBrowseOutput}
            >
              Browse…
            </button>
          </div>
        </label>
        <button
          type="button"
          className={`${ui.btn} ${ui.primary} ${ui.fullWidth}`}
          onClick={onGenerate}
        >
          Add to queue &amp; generate file
        </button>
      </section>
    </>
  );
}
