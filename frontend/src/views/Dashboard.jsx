import { useDeferredValue, useMemo, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { SearchField, ShipmentTable } from "../components.jsx";
import { ALERT_DAYS, matchesQuery, timeAgo } from "../lib.js";

const COLUMNS = ["est", "date", "exitNo", "cheque", "agent", "eta", "bl", "telex"];

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "arriving", label: `Arriving in ${ALERT_DAYS} days`, test: (s) => s.etaDays !== null && s.etaDays >= 0 && s.etaDays <= ALERT_DAYS },
  { id: "refunds", label: "Refunds due", test: (s) => s.refundDays !== null && s.refundDays <= ALERT_DAYS && s.refundStatus !== "Received" },
  { id: "telex", label: "Telex pending", test: (s) => Boolean(s.bl) && s.telexStatus !== "Released" }
];

export function Dashboard({ data, onOpen }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const shipments = data?.shipments;

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, (shipments || []).filter(f.test).length])),
    [shipments]
  );

  // Newest register rows first.
  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter).test;
    return (shipments || []).filter((s) => test(s) && matchesQuery(s, needle)).sort((a, b) => b.row - a.row);
  }, [shipments, filter, needle]);

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">{shipments ? `${shipments.length} register rows${data.modifiedAt ? ` · updated ${timeAgo(data.modifiedAt)}` : ""}` : "Loading register…"}</p>
        </div>
        <a className="btn" href="/api/excel/download" download><DownloadSimple size={15} /> Download .xlsx</a>
      </header>

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Filter shipments">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>
              {f.label} <span className="count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search BL, EST, exit, agent…" />
      </div>

      <ShipmentTable rows={rows} columns={COLUMNS} onOpen={onOpen} empty={shipments ? "No shipments match." : "Loading…"} />
      <p className="hint muted">Select a row to update the cheque amount, refund date, telex or payment status.</p>
    </section>
  );
}
