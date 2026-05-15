import type { Job } from "../../types/tts";
import { basename } from "../../utils";
import ui from "../../styles/ui.module.css";
import styles from "./JobQueue.module.css";

interface JobQueueProps {
  jobs: Job[];
  onCancel: (jobId: string) => void;
  onReveal: (path: string) => void;
  onPlay: (job: Job) => void;
  onClearDone: () => void;
}

export function JobQueue({
  jobs,
  onCancel,
  onReveal,
  onPlay,
  onClearDone,
}: JobQueueProps) {
  return (
    <section className={`${ui.panel} ${styles.panel}`}>
      <div className={styles.panelHead}>
        <h2>Queue</h2>
        <button
          type="button"
          className={`${ui.btn} ${ui.ghost} ${ui.small}`}
          onClick={onClearDone}
        >
          Clear finished
        </button>
      </div>
      <ul className={styles.jobList}>
        {jobs.map((job) => {
          const pct = Math.round(job.progress * 100);
          const statusClass =
            job.status === "done"
              ? styles.statusDone
              : job.status === "error"
                ? styles.statusError
                : "";
          return (
            <li
              key={job.id}
              className={`${styles.jobItem} ${statusClass}`}
            >
              <div className={styles.title}>{job.title}</div>
              <div className={styles.meta}>
                {job.status} · {pct}%
                {job.outputPath ? ` · ${basename(job.outputPath)}` : ""}
              </div>
              {job.error ? (
                <div className={styles.jobError}>{job.error}</div>
              ) : null}
              <div className={styles.jobProgress}>
                <div
                  className={styles.jobProgressBar}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className={`${ui.row} ${styles.jobActions}`}>
                {(job.status === "running" || job.status === "queued") && (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.ghost} ${ui.small}`}
                    onClick={() => onCancel(job.id)}
                  >
                    Cancel
                  </button>
                )}
                {job.status === "done" && job.outputPath && (
                  <>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.ghost} ${ui.small}`}
                      onClick={() => onReveal(job.outputPath!)}
                    >
                      Show in Finder
                    </button>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.ghost} ${ui.small}`}
                      onClick={() => onPlay(job)}
                    >
                      Play
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className={`${ui.muted} ${jobs.length > 0 ? styles.hidden : ""}`}>
        No jobs yet. Add text above to start.
      </p>
    </section>
  );
}
