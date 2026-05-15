import ui from "../../styles/ui.module.css";
import styles from "./DictionaryView.module.css";

export interface DictRow {
  id: string;
  key: string;
  value: string;
}

interface DictionaryViewProps {
  rows: DictRow[];
  onRowChange: (id: string, field: "key" | "value", text: string) => void;
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onSave: () => void;
}

export function DictionaryView({
  rows,
  onRowChange,
  onAddRow,
  onRemoveRow,
  onSave,
}: DictionaryViewProps) {
  return (
    <section className={`${ui.panel} ${styles.panel}`}>
      <div className={styles.tableHead}>
        <span>From</span>
        <span>Speak as</span>
        <span />
      </div>
      <div className={styles.rows}>
        {rows.map((row) => (
          <div key={row.id} className={styles.row}>
            <input
              type="text"
              className={ui.textField}
              placeholder="From"
              value={row.key}
              onChange={(e) => onRowChange(row.id, "key", e.target.value)}
            />
            <input
              type="text"
              className={ui.textField}
              placeholder="Speak as"
              value={row.value}
              onChange={(e) => onRowChange(row.id, "value", e.target.value)}
            />
            <button
              type="button"
              className={`${ui.btn} ${ui.ghost} ${ui.small}`}
              onClick={() => onRemoveRow(row.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className={`${ui.row} ${styles.actions}`}>
        <button
          type="button"
          className={`${ui.btn} ${ui.secondary}`}
          onClick={onAddRow}
        >
          Add row
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.primary} ${styles.actionsPrimary}`}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </section>
  );
}
