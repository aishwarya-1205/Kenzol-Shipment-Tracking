import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ArrowsClockwise, DownloadSimple, Trash } from "@phosphor-icons/react";
import { CarrierSelect, Nil, Notice, SearchField, Spinner } from "../components.jsx";
import { formatDate, timeAgo } from "../lib.js";

// Columns shown in the standard view, mapped to the workbook headers.
const STANDARD = [
  { key: "Date", label: "Date", date: true },
  { key: "BL NUMBER", label: "BL number", mono: true },
  { key: "Shipping Line", label: "Shipping line", clamp: true },
  { key: "Container No", label: "Containers", clamp: true },
  { key: "point of loading", label: "Loading point", clamp: true },
  { key: "Destination", label: "Destination", clamp: true },
  { key: "VESSEL ETD", label: "ETD", date: true },
  { key: "VESSEL ETA", label: "ETA", date: true }
];
const PAGE = 50;

function ConfirmDelete({ target, busy, error, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div className="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <header className="modal-head">
          <div>
            <h2 id="confirm-title">Delete row {target.row}?</h2>
            <p className="muted">{target.bl ? `BL ${target.bl}. ` : ""}The row is removed from the register permanently.</p>
          </div>
        </header>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot modal-foot-end">
          <button ref={cancelRef} className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>{busy && <Spinner />} Delete</button>
        </footer>
      </div>
    </div>
  );
}

export function RegisterView({ excel, showAll, onToggleAll, onReload, onSync, onDelete, onTrack, savingExcel, notice, onDismissNotice, highlightRows }) {
  const [withBl, setWithBl] = useState(true);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [syncBl, setSyncBl] = useState("");
  const [syncCarrier, setSyncCarrier] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const { data, loading, error } = excel;

  // Lower-cased search text is built once per load, so typing only runs substring checks.
  const searchable = useMemo(
    () => (data?.rows || []).map((row) => ({ row, text: Object.values(row.values).map((v) => v ?? "").join(" ").toLowerCase() })),
    [data]
  );
  const rows = useMemo(() => {
    const out = [];
    for (let i = searchable.length - 1; i >= 0; i--) {
      const { row, text } = searchable[i];
      if (withBl && !row.hasBL) continue;
      if (needle && !text.includes(needle)) continue;
      out.push(row);
    }
    return out;
  }, [searchable, withBl, needle]);

  const columns = useMemo(() => {
    if (!showAll || !data) return STANDARD;
    return data.columns.map((key) => ({
      key,
      label: key,
      mono: key.toLowerCase() === "bl number",
      clamp: true,
      date: /\b(date|eta|etd)\b/i.test(key)
    }));
  }, [showAll, data]);
  const blKey = columns.find((c) => c.key.toLowerCase() === "bl number")?.key ?? "BL NUMBER";

  useEffect(() => setLimit(PAGE), [withBl, needle, showAll]);

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete(deleteTarget.row, deleteTarget.bl);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  const canSync = syncBl.trim().length >= 5 && !savingExcel;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Register</h1>
          <p className="muted">
            {data ? `${data.totalRecords} rows · ${data.trackedRecords} with a BL${data.modifiedAt ? ` · saved ${timeAgo(data.modifiedAt)}` : ""}` : "The shipment database behind every page."}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={onReload} disabled={loading}>{loading ? <Spinner /> : <ArrowsClockwise size={15} />} Reload</button>
          <a className="btn" href="/api/excel/download" download><DownloadSimple size={15} /> Download .xlsx</a>
        </div>
      </header>

      <Notice notice={notice} onDismiss={onDismissNotice} />

      <form
        className="track-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (canSync && (await onSync(syncBl.trim().replace(/\s+/g, ""), syncCarrier))) setSyncBl("");
        }}
      >
        <input className="input mono" value={syncBl} onChange={(event) => setSyncBl(event.target.value)} placeholder="BL number to sync from the carrier" aria-label="BL number to sync" autoComplete="off" spellCheck="false" />
        <CarrierSelect id="sync-carrier" value={syncCarrier} onChange={setSyncCarrier} />
        <button type="submit" className="btn btn-primary" disabled={!canSync}>{savingExcel && <Spinner />} {savingExcel ? "Syncing…" : "Sync BL"}</button>
      </form>
      <p className="hint muted">Sync writes the carrier, containers, ports and vessel dates to every row of that BL, or adds a new row.</p>

      {error && !data && <Notice notice={{ type: "error", title: "Could not load the register", text: error }} onDismiss={onReload} />}

      {data && (
        <>
          <div className="toolbar">
            <div className="toolbar-group">
              <div className="tabs" role="tablist" aria-label="Rows">
                <button role="tab" aria-selected={withBl} className={withBl ? "on" : ""} onClick={() => setWithBl(true)}>With BL <span className="count">{data.trackedRecords}</span></button>
                <button role="tab" aria-selected={!withBl} className={!withBl ? "on" : ""} onClick={() => setWithBl(false)}>All rows <span className="count">{data.totalRecords}</span></button>
              </div>
              <div className="tabs" role="group" aria-label="Columns">
                <button aria-pressed={!showAll} className={!showAll ? "on" : ""} onClick={() => onToggleAll(false)}>Standard</button>
                <button aria-pressed={showAll} className={showAll ? "on" : ""} onClick={() => onToggleAll(true)}>All columns</button>
              </div>
            </div>
            <SearchField value={query} onChange={setQuery} placeholder="Search BL, container, port…" label="Search register" />
          </div>

          <div className="table-wrap">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th className="cell-num">Row</th>
                    {columns.map((col) => <th key={col.key}>{col.label}</th>)}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((row) => {
                    const bl = row.hasBL ? String(row.values[blKey]) : "";
                    return (
                      <tr key={row.row} className={highlightRows.includes(row.row) ? "is-updated" : ""}>
                        <td className="cell-num muted">{row.row}</td>
                        {columns.map((col) => {
                          const raw = row.values[col.key];
                          const value = raw === null || raw === undefined || raw === "" ? null : col.date ? formatDate(raw) : String(raw);
                          return (
                            <td key={col.key} className={[col.mono && "mono", col.clamp && "clamp", col.date && "nowrap"].filter(Boolean).join(" ")} title={col.clamp && value ? value : undefined}>
                              {value ?? <Nil />}
                            </td>
                          );
                        })}
                        <td className="cell-action">
                          {bl && <button className="link-btn" onClick={() => onTrack(bl)}>Track <ArrowUpRight size={13} /></button>}
                          <button className="icon-btn icon-danger" onClick={() => { setDeleteError(""); setDeleteTarget({ row: row.row, bl }); }} aria-label={`Delete row ${row.row}`} title="Delete row">
                            <Trash size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!rows.length && <p className="empty">No matching rows.</p>}
            </div>
            <div className="table-foot">
              <span>{Math.min(limit, rows.length)} of {rows.length} · newest first</span>
              {rows.length > limit && <button className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE * 2)}>Show more</button>}
            </div>
          </div>
        </>
      )}

      {loading && !data && <p className="loading"><Spinner /> Loading register…</p>}
      {deleteTarget && <ConfirmDelete target={deleteTarget} busy={deleting} error={deleteError} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} />}
    </section>
  );
}
