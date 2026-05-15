import type { ViewName } from "../../types/tts";
import ui from "../../styles/ui.module.css";
import styles from "./Header.module.css";

interface HeaderProps {
  currentView: ViewName;
  modelStatusText: string;
  modelStatusClass: "" | "ready" | "loading";
  onViewChange: (view: ViewName) => void;
}

export function Header({
  currentView,
  modelStatusText,
  modelStatusClass,
  onViewChange,
}: HeaderProps) {
  const badgeClass =
    modelStatusClass === "ready"
      ? ui.badgeReady
      : modelStatusClass === "loading"
        ? ui.badgeLoading
        : ui.badge;

  return (
    <header className={styles.header}>
      <div className={styles.headerStart}>
        <h1>ReadingTime</h1>
        <nav className={styles.nav} aria-label="Main">
          <button
            type="button"
            className={
              currentView === "synthesize"
                ? styles.navBtnActive
                : styles.navBtn
            }
            onClick={() => onViewChange("synthesize")}
          >
            Synthesize
          </button>
          <button
            type="button"
            className={
              currentView === "settings" ? styles.navBtnActive : styles.navBtn
            }
            onClick={() => onViewChange("settings")}
          >
            Dictionary
          </button>
        </nav>
      </div>
      <span className={badgeClass}>{modelStatusText}</span>
    </header>
  );
}
