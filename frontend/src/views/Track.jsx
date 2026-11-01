import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, ArrowsClockwise, Database, X } from "@phosphor-icons/react";
import { CarrierSelect, Notice, SearchField, ShipmentTable, Spinner } from "../components.jsx";
import { CATEGORIES, daysFromToday, formatDate, formatDateTime, matchesQuery, relativeDays, timeAgo } from "../lib.js";

const CATEGORY_COLUMNS = ["date", "exitNo", "bl", "type", "consignee", "destination", "agent", "eta"];

function statusTone(code) {
  const c = String(code || "").toUpperCase();
  if (c.includes("DELIVER")) return "badge-ok";
  if (c.includes("TRANSIT")) return "badge-accent";
  return "";
}

// An event is planned when the carrier says so, or when it is dated in the future
// and the carrier did not say either way.
const isPlanned = (event) => event.isActual === false || (event.isActual == null && Date.parse(event.date) > Date.now());

function Timeline({ events }) {
  if (!events.length) return <p className="empty">The carrier returned no milestones for this BL.</p>;
  const planned = events.filter(isPlanned);
  const actual = events.filter((event) => !isPlanned(event)).reverse();
  const item = (event, index, kind) => (
    <li key={`${event.id}-${index}`} className={`tl-item ${kind}`}>
      <span className="tl-dot" />
      <div>
        <div className="tl-title">
          <strong>{event.title}</strong>
          {kind === "is-latest" && <span className="badge badge-accent">Latest</span>}
          {kind === "is-planned" && <span className="badge">Planned</span>}
        </div>
        <small className="muted">{[event.location, event.transport, formatDateTime(event.date)].filter(Boolean).join(" · ")}</small>
      </div>
    </li>
  );
  return (
    <ol className="timeline">
      {planned.map((event, i) => item(event, i, "is-planned"))}
      {actual.map((event, i) => item(event, i, i === 0 ? "is-latest" : ""))}
    </ol>
  );
}

function ShipmentResult({ shipment, refreshing, saving, notice, onRefresh, onSave, onClear, onDismissNotice, onOpenRegister }) {
  const etaDays = daysFromToday(shipment.eta);
  const containers = shipment.containers.map((c) => c.containerNumber).filter(Boolean);
  return (
    <section className="card result">
      <header className="result-head">
        <div>
          <span className="eyebrow">Bill of lading</span>
          <h2 className="mono">{shipment.shipmentNumber}</h2>
        </div>
        <span className={`badge badge-lg ${statusTone(shipment.statusCode)}`}>{shipment.status}</span>
        <div className="result-actions">
          <button className="btn" onClick={onRefresh} disabled={refreshing || saving}>
            {refreshing ? <Spinner /> : <ArrowsClockwise size={15} />} Refresh
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving || refreshing}>
            {saving ? <Spinner /> : <Database size={15} />} {saving ? "Saving…" : "Save to register"}
          </button>
          <button className="icon-btn" onClick={onClear} aria-label="Close result"><X size={16} /></button>
        </div>
      </header>

      <Notice notice={notice} onDismiss={onDismissNotice}>
        {notice?.type === "success" && <button className="link-btn" onClick={onOpenRegister}>Open register <ArrowRight size={13} /></button>}
      </Notice>

      <dl className="facts">
        <div><dt>Carrier</dt><dd>{shipment.carrier}</dd></div>
        <div><dt>From</dt><dd>{shipment.origin}</dd></div>
        <div><dt>To</dt><dd>{shipment.destination}</dd></div>
        <div>
          <dt>{shipment.etaActual ? "Arrived" : "Estimated arrival"}</dt>
          <dd>
            {shipment.eta ? formatDateTime(shipment.eta) : "Not provided"}
            {shipment.eta && !shipment.etaActual && etaDays !== null && (
              <small className="muted"> · {etaDays < 0 ? `estimate passed ${relativeDays(etaDays)}, arrival not confirmed` : relativeDays(etaDays)}</small>
            )}
          </dd>
        </div>
        <div><dt>Carrier update</dt><dd>{shipment.lastUpdated ? `${formatDate(shipment.lastUpdated)} (${timeAgo(shipment.lastUpdated)})` : "Not provided"}</dd></div>
      </dl>

      <div className="result-grid">
        <div>
          <h3 className="section-title">Milestones <span className="count">{shipment.events.length}</span></h3>
          <Timeline events={shipment.events} />
        </div>
        <div>
          <h3 className="section-title">Containers <span className="count">{containers.length}</span></h3>
          {containers.length ? (
            <ul className="plain-list mono">{containers.map((number) => <li key={number}>{number}</li>)}</ul>
          ) : <p className="empty">No container numbers returned.</p>}
        </div>
      </div>
      <p className="hint muted">Carrier data is refreshed when the carrier publishes new events; it is not live vessel positioning.</p>
    </section>
  );
}

export function TrackView({ category, onCategory, data, onOpen, onTrack, track }) {
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());
  const shipments = data?.shipments;
  const canSearch = track.blNumber.trim().length >= 5 && !track.loading;

  const counts = useMemo(() => {
    const out = { all: 0 };
    for (const s of shipments || []) {
      out.all++;
      out[s.category] = (out[s.category] || 0) + 1;
    }
    return out;
  }, [shipments]);

  const rows = useMemo(
    () => (shipments || []).filter((s) => (!category || s.category === category) && matchesQuery(s, needle)).sort((a, b) => b.row - a.row),
    [shipments, category, needle]
  );

  const label = CATEGORIES.find((c) => c.id === category)?.label;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Track shipment</h1>
          <p className="muted">Look up a Bill of Lading with the carrier, or browse shipments by type.</p>
        </div>
      </header>

      <form className="track-form" onSubmit={(event) => { event.preventDefault(); if (canSearch) track.onSubmit(); }}>
        <input
          className="input mono"
          value={track.blNumber}
          onChange={(event) => track.setBlNumber(event.target.value)}
          placeholder="Bill of Lading number, e.g. MEDUH9197102"
          aria-label="Bill of Lading number"
          autoComplete="off"
          spellCheck="false"
        />
        <CarrierSelect id="carrier" value={track.carrier} onChange={track.setCarrier} />
        <button type="submit" className="btn btn-primary" disabled={!canSearch}>
          {track.loading ? <><Spinner /> Tracking…</> : "Track"}
        </button>
      </form>
      {track.error && <Notice notice={{ type: "error", title: "Could not track this BL", text: track.error }} onDismiss={track.onDismissError} />}
      {track.recent.length > 0 && !track.shipment && (
        <div className="recent">
          <span className="muted">Recent</span>
          {track.recent.map((item) => (
            <button key={item.bl} className="chip mono" onClick={() => track.onPickRecent(item)} title={`${item.status} · ${timeAgo(item.searchedAt)}`}>{item.bl}</button>
          ))}
          <button className="link-btn" onClick={track.onClearRecent}>Clear</button>
        </div>
      )}

      {track.loading && !track.shipment && <p className="loading"><Spinner /> Asking the carrier for the latest events…</p>}
      {track.shipment && (
        <ShipmentResult
          shipment={track.shipment}
          refreshing={track.loading}
          saving={track.saving}
          notice={track.notice}
          onRefresh={track.onRefresh}
          onSave={track.onSave}
          onClear={track.onClear}
          onDismissNotice={track.onDismissNotice}
          onOpenRegister={track.onOpenRegister}
        />
      )}

      <div className="section-head">
        <h2>{label ? `${label} shipments` : "All shipments"}</h2>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Shipment type">
          {[{ id: "", label: "All" }, ...CATEGORIES].map((c) => (
            <button key={c.id || "all"} role="tab" aria-selected={(category || "") === c.id} className={(category || "") === c.id ? "on" : ""} onClick={() => onCategory(c.id)}>
              {c.label} <span className="count">{counts[c.id || "all"] || 0}</span>
            </button>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search BL, exit, consignee…" />
      </div>
      <ShipmentTable
        rows={rows}
        columns={CATEGORY_COLUMNS}
        onOpen={onOpen}
        onTrack={onTrack}
        empty={category === "import" ? "No import shipments in the register yet. Set TYPE to IMPORT in the register to list them here." : "No shipments match."}
      />
      {counts.unclassified > 0 && !category && <p className="hint muted">{counts.unclassified} rows have no type or destination and only appear under All.</p>}
    </section>
  );
}
