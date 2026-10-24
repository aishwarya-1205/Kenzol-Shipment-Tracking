import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Anchor, ArrowLeft, ArrowRight, ArrowUpRight, ArrowsClockwise, Bell, Boat, Bookmarks,
  CalendarBlank, CaretDown, CheckCircle, Clock, ClockCounterClockwise, Cube,
  DownloadSimple, FileXls, MagnifyingGlass, MapPin, Path, PencilSimple, ShieldCheck, Table, Truck,
  WarningCircle, X
} from "@phosphor-icons/react";
import { scrollToElement, scrollToTop } from "./smoothScroll.js";

const CARRIERS = [
  { value: "", label: "Auto-detect carrier" },
  { value: "MSC", label: "MSC" },
  { value: "Hapag-Lloyd", label: "Hapag-Lloyd" },
  { value: "CMA CGM", label: "CMA CGM" },
  { value: "Maersk", label: "Maersk" },
  { value: "MCL", label: "MCL" }
];

const RECENT_KEY = "kenzol-recent";
const SUMMARY_KEY = "kenzol-summary-bls";
// BL -> local date ("YYYY-MM-DD") on which "Not yet" was clicked; the BL is asked about again the next day.
const PAYMENT_SNOOZE_KEY = "kenzol-payment-snooze";
const PAYMENT_CHECK_MS = 60 * 60 * 1000;
const EXCEL_DOWNLOAD_URL = "/api/excel/download";

// Register columns shown in the Excel view, mapped to the workbook headers.
const REGISTER_TABLE = [
  { key: "Date", label: "Date", date: true },
  { key: "BL NUMBER", label: "BL number", mono: true },
  { key: "Shipping Line", label: "Shipping line" },
  { key: "Container No", label: "Containers", clamp: true },
  { key: "point of loading", label: "Loading port", clamp: true },
  { key: "Destination", label: "Destination", clamp: true },
  { key: "VESSEL ETD", label: "ETD", date: true },
  { key: "VESSEL ETA", label: "ETA", date: true }
];

const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const VIEW_LABELS = { track: "Track shipment", summary: "Shipment summary", excel: "Excel register" };

function readField(obj, keys, fallback = "—") {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

// Only ISO-style strings are parsed; workbook dates such as "05/1/2026" are shown as written
// so day/month order is never reinterpreted by the browser.
function formatDate(value, fallback = "Date unavailable") {
  if (!value || value === "—") return fallback;
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

// Like formatDate, but keeps the provider's time of day when one is given.
function formatDateTime(value, fallback) {
  const date = formatDate(value, fallback);
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(String(value || ""));
  return match && `${match[1]}:${match[2]}` !== "00:00" ? `${date} · ${match[1]}:${match[2]}` : date;
}

function splitBls(text) {
  return text.split(/[\s,;]+/).map((part) => part.trim().toUpperCase()).filter((part) => part.length >= 5);
}

// Blank means "no amount"; otherwise a non-negative number, commas allowed as separators.
function parseAmount(text) {
  const cleaned = String(text ?? "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
}

function timeAgo(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) return "";
  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeResponse(raw, blNumber, selectedCarrier) {
  // Accept common provider/backend response shapes without inventing data.
  const root = raw?.data ?? raw?.shipment ?? raw;
  const containers = root?.containers ?? root?.groups ?? root?.containerDetails ?? [];
  const firstContainer = Array.isArray(containers) ? containers[0] : null;
  let rawEvents = root?.events ?? root?.milestones ?? root?.trackingEvents ?? firstContainer?.events ?? [];

  if (!Array.isArray(rawEvents)) rawEvents = [];
  const events = rawEvents.map((event, index) => ({
    id: event.id ?? `${event.eventDate ?? event.date ?? "event"}-${index}`,
    title: readField(event, ["eventDescription", "description", "title", "event", "status", "milestone"], "Shipment event"),
    location: readField(event, ["eventLocation", "location", "facility", "place"], ""),
    date: readField(event, ["eventDateTime", "eventDate", "dateTime", "date", "timestamp"], ""),
    time: readField(event, ["eventTime", "time"], ""),
    transport: readField(event, ["eventTransport", "transport", "transportMode"], ""),
    isActual: event.isActual
  }));

  const sortedEvents = [...events].sort((a, b) => {
    const da = new Date(`${a.date || ""} ${a.time || ""}`).getTime();
    const db = new Date(`${b.date || ""} ${b.time || ""}`).getTime();
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    return da - db;
  });

  const containerNumbers = Array.isArray(containers)
    ? containers.map((c) => typeof c === "string" ? c : readField(c, ["containerNumber", "number", "containerNo"], "")).filter(Boolean)
    : [];
  const latest = sortedEvents.length ? sortedEvents[sortedEvents.length - 1] : null;

  return {
    shipmentNumber: readField(root, ["shipmentNumber", "billOfLading", "billOfLadingNumber", "blNumber", "reference"], blNumber),
    carrier: readField(root, ["carrier", "shippingLine", "sealineName", "carrierName"], selectedCarrier || "Carrier detected by provider"),
    status: readField(root, ["status", "shipmentStatus", "latestStatus"], latest?.title ?? "Status unavailable"),
    statusCode: readField(root, ["statusCode"], ""),
    origin: readField(root, ["origin", "originName", "placeOfReceipt", "portOfLoading"], "Not provided"),
    destination: readField(root, ["destination", "destinationName", "placeOfDelivery", "portOfDischarge"], "Not provided"),
    eta: readField(root, ["eta", "estimatedArrival", "estimatedTimeOfArrival", "arrivalDate"], ""),
    lastUpdated: readField(root, ["lastUpdated", "updatedAt", "lastEventDate"], latest?.date ?? ""),
    containers: containerNumbers,
    events: sortedEvents
  };
}

function statusTone(status = "") {
  const s = String(status).toLowerCase();
  if (/deliver|arriv|discharg|gate.in/.test(s)) return "green";
  if (/delay|exception|hold|customs|rollover/.test(s)) return "amber";
  if (/depart|sail|transit|loaded|vessel|planned/.test(s)) return "orange";
  return "slate";
}

// Visual position of the vessel along the route, derived only from the provider status code.
function routeProgress(shipment) {
  const code = String(shipment.statusCode || shipment.status).toUpperCase();
  if (code.includes("DELIVER")) return 1;
  if (code.includes("TRANSIT")) return 0.55;
  if (code.includes("PLANNED")) return 0.08;
  return 0;
}

const API_BASE_URL = (
  import.meta.env.VITE_API_URL ||
  "http://127.0.0.1:8000"
).replace(/\/+$/, "");

async function apiRequest(url, options) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, ...options });
  } catch {
    throw new Error("Could not reach the Kenzol backend. Make sure FastAPI is running on port 8000.");
  }
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : { detail: await response.text() };
  if (!response.ok) {
    const detail = payload?.detail || payload?.message || `Request failed (${response.status}).`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

/* Fades sections in as they enter the viewport. Re-scans whenever `deps` change. */
function useReveal(deps) {
  useEffect(() => {
    const nodes = document.querySelectorAll(".reveal:not(.is-visible)");
    if (!("IntersectionObserver" in window)) {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/* ---------- Shared pieces ---------- */

function Spinner({ size = 16 }) {
  return <ArrowsClockwise size={size} weight="bold" className="spin" />;
}

function DownloadExcelButton({ variant = "primary", label = "Download Excel" }) {
  return (
    <a className={`btn btn-${variant}`} href={EXCEL_DOWNLOAD_URL} download>
      <DownloadSimple size={16} weight="bold" /> {label}
    </a>
  );
}

function ExcelNotice({ notice, onDismiss, onOpenRegister }) {
  if (!notice) return null;
  const success = notice.type === "success";
  return (
    <div className={`notice notice-${notice.type}`} role="status">
      <span className="notice-icon">
        {success ? <CheckCircle size={20} weight="fill" /> : <WarningCircle size={20} weight="fill" />}
      </span>
      <div className="notice-body">
        <strong>{success ? notice.title : "Excel was not updated"}</strong>
        <p>{notice.text}</p>
        {success && (
          <div className="notice-actions">
            <DownloadExcelButton label="Download updated Excel" />
            {onOpenRegister && (
              <button className="btn btn-ghost" onClick={onOpenRegister}>
                <Table size={16} /> View in register
              </button>
            )}
          </div>
        )}
      </div>
      <button className="icon-button" onClick={onDismiss} aria-label="Dismiss"><X size={16} /></button>
    </div>
  );
}

function CarrierSelect({ id, value, onChange }) {
  return (
    <div className="field">
      <Anchor size={18} className="field-icon" />
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {CARRIERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <CaretDown size={14} weight="bold" className="field-caret" />
    </div>
  );
}

/* ---------- Layout ---------- */

function Sidebar({ view, onNavigate, excelCount, summaryCount }) {
  const items = [
    { id: "track", label: VIEW_LABELS.track, icon: MagnifyingGlass },
    { id: "summary", label: VIEW_LABELS.summary, icon: Bookmarks, badge: summaryCount },
    { id: "excel", label: VIEW_LABELS.excel, icon: FileXls, badge: excelCount }
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/kenzol-wordmark.svg" alt="Kenzol" className="brand-logo" />
        <span className="brand-product">Shipping Tracking</span>
      </div>

      <nav className="nav" aria-label="Workspace">
        <span className="nav-label">Workspace</span>
        {items.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "active" : ""}`}
            onClick={() => onNavigate(id)}
            aria-current={view === id ? "page" : undefined}
          >
            <Icon size={19} weight={view === id ? "fill" : "regular"} />
            <span className="nav-text">{label}</span>
            {badge ? <span className="nav-badge">{badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <p className="tagline">Focusing on Enhanced Performance</p>
        <span className="version">Internal tool · v1.1</span>
      </div>
    </aside>
  );
}

function HealthBadge({ health }) {
  const state = health === null ? "checking" : !health ? "offline" : health.apiKeyConfigured ? "ok" : "warn";
  const text = {
    checking: "Checking service…",
    offline: "Backend offline",
    ok: "Tracking API connected",
    warn: "API key missing"
  }[state];
  return <span className={`health health-${state}`}><span className="health-dot" />{text}</span>;
}

function Topbar({ view, health }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>Workspace</span>
        <span className="crumb-sep">/</span>
        <strong>{VIEW_LABELS[view]}</strong>
      </div>
      <div className="topbar-right">
        <HealthBadge health={health} />
        <span className="avatar" aria-hidden="true">KZ</span>
      </div>
    </header>
  );
}

/* ---------- Track view ---------- */

function Swoosh({ className }) {
  // Echoes the twin orange-to-red arcs from the Kenzol logo.
  return (
    <svg className={className} viewBox="0 0 1200 420" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="swoosh-top" x1="0" x2="1">
          <stop offset="0" stopColor="#e2262d" stopOpacity="0" />
          <stop offset=".6" stopColor="#e2262d" />
          <stop offset="1" stopColor="#f7941d" />
        </linearGradient>
        <linearGradient id="swoosh-bottom" x1="0" x2="1">
          <stop offset="0" stopColor="#f7941d" />
          <stop offset=".5" stopColor="#e2262d" />
          <stop offset="1" stopColor="#e2262d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M380 34 A640 230 0 0 1 1190 150 A640 214 0 0 0 380 34Z" fill="url(#swoosh-top)" />
      <path d="M10 250 A640 230 0 0 0 820 400 A640 214 0 0 1 10 250Z" fill="url(#swoosh-bottom)" />
    </svg>
  );
}

function SearchHero({ blNumber, setBlNumber, carrier, setCarrier, loading, error, onDismissError, onSubmit }) {
  const canSearch = blNumber.trim().length >= 5 && !loading;
  return (
    <section className="hero reveal">
      <Swoosh className="hero-swoosh" />
      <div className="hero-copy">
        <span className="eyebrow eyebrow-light"><span className="eyebrow-bar" />Ocean freight visibility</span>
        <h1>Know where every <span className="text-brand">shipment</span> stands.</h1>
        <p>Track any Bill of Lading across major shipping lines, review every reported milestone and push the results straight into your Excel register.</p>
        <ul className="hero-points">
          <li><Path size={16} /> Live milestones</li>
          <li><Cube size={16} /> Container details</li>
          <li><FileXls size={16} /> One-click Excel sync</li>
        </ul>
      </div>

      <form className="search-card" onSubmit={(event) => { event.preventDefault(); if (canSearch) onSubmit(); }}>
        <div className="search-card-head">
          <span className="tile tile-brand"><MagnifyingGlass size={20} weight="bold" /></span>
          <div>
            <h2>Track a shipment</h2>
            <p>Enter a Bill of Lading reference.</p>
          </div>
        </div>

        <label htmlFor="bl-number">Bill of Lading number</label>
        <div className="field">
          <MagnifyingGlass size={18} className="field-icon" />
          <input
            id="bl-number"
            value={blNumber}
            onChange={(event) => setBlNumber(event.target.value)}
            placeholder="e.g. MEDUH9197102"
            autoComplete="off"
            spellCheck="false"
          />
        </div>

        <label htmlFor="carrier">Shipping line <span className="optional">Optional</span></label>
        <CarrierSelect id="carrier" value={carrier} onChange={setCarrier} />

        <button type="submit" className="btn btn-primary btn-block" disabled={!canSearch}>
          {loading ? <><Spinner /> Fetching shipment…</> : <>Track shipment <ArrowRight size={16} weight="bold" /></>}
        </button>

        {error && (
          <div className="inline-error" role="alert">
            <WarningCircle size={18} weight="fill" />
            <span>{error}</span>
            <button type="button" className="icon-button" onClick={onDismissError} aria-label="Dismiss error"><X size={14} /></button>
          </div>
        )}

        <div className="search-card-foot">
          <span><ShieldCheck size={14} /> Key kept server-side</span>
          <span>Coverage depends on carrier</span>
        </div>
      </form>
    </section>
  );
}

function LoadingPanel() {
  return (
    <div className="loading-panel">
      <span className="tile tile-brand loading-tile"><Boat size={22} /></span>
      <div>
        <strong>Finding your shipment</strong>
        <p>Checking the latest available tracking events…</p>
      </div>
      <span className="loading-bar"><span /></span>
    </div>
  );
}

function EventTimeline({ events }) {
  if (!events.length) {
    return (
      <div className="empty-inline">
        <Clock size={22} />
        <div><strong>No event timeline returned</strong><p>The provider returned no milestone events for this search.</p></div>
      </div>
    );
  }
  const ordered = events.slice().reverse();
  return (
    <ol className="timeline">
      {ordered.map((event, index) => (
        <li className={`timeline-item ${index === 0 ? "is-latest" : ""} ${event.isActual === false ? "is-planned" : ""}`} key={`${event.id}-${index}`}>
          <span className="timeline-dot" />
          <div className="timeline-body">
            <div className="timeline-title">
              <h4>{event.title}</h4>
              {index === 0 && <span className="chip chip-brand">Latest</span>}
              {event.isActual === false && <span className="chip">Planned</span>}
            </div>
            <div className="timeline-meta">
              {event.location && event.location !== "—" && <span><MapPin size={14} />{event.location}</span>}
              {event.transport && event.transport !== "—" && <span><Truck size={14} />{event.transport}</span>}
              <span><CalendarBlank size={14} />{formatDate(event.date)}{event.time && event.time !== "—" ? ` · ${event.time}` : ""}</span>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ShipmentResults({ shipment, refreshing, onRefresh, onClear, onUpdateExcel, savingExcel, notice, onDismissNotice, onOpenRegister }) {
  const tone = statusTone(shipment.status);
  const progress = routeProgress(shipment);
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(progress));
    return () => cancelAnimationFrame(id);
  }, [progress]);

  const stats = [
    { icon: Anchor, label: "Carrier", value: shipment.carrier, hint: "Shipping line" },
    { icon: CalendarBlank, label: "Est. arrival", value: shipment.eta ? formatDate(shipment.eta) : "Not provided", hint: "From provider route data" },
    { icon: Cube, label: "Containers", value: shipment.containers.length || "—", hint: shipment.containers.length ? shipment.containers.slice(0, 2).join(", ") : "None returned" },
    { icon: Clock, label: "Last update", value: shipment.lastUpdated ? formatDate(shipment.lastUpdated) : "Not provided", hint: "Latest timestamp received" }
  ];

  return (
    <section className="results">
      <div className="results-head reveal">
        <div>
          <button className="back-link" onClick={onClear}><ArrowLeft size={15} /> New search</button>
          <span className="eyebrow"><span className="eyebrow-bar" />Shipment overview</span>
          <h2 className="section-heading">Tracking details</h2>
        </div>
        <div className="results-actions">
          <button className="btn btn-secondary" onClick={onRefresh} disabled={refreshing || savingExcel}>
            {refreshing ? <Spinner /> : <ArrowsClockwise size={16} />} {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn btn-excel" onClick={onUpdateExcel} disabled={savingExcel || refreshing}>
            {savingExcel ? <Spinner /> : <FileXls size={17} weight="fill" />}
            {savingExcel ? "Updating Excel…" : "Update in Excel"}
          </button>
        </div>
      </div>

      <ExcelNotice notice={notice} onDismiss={onDismissNotice} onOpenRegister={onOpenRegister} />

      <article className="overview-card reveal">
        <div className="overview-top">
          <span className="tile tile-ink"><Boat size={22} /></span>
          <div className="overview-title">
            <span className="label">Bill of Lading</span>
            <h3>{shipment.shipmentNumber}</h3>
          </div>
          <span className={`status status-${tone}`}><span className="status-dot" />{shipment.status}</span>
        </div>

        <div className="route">
          <div className="route-end">
            <span className="label"><span className="route-pin" />Origin</span>
            <strong>{shipment.origin}</strong>
          </div>
          <div className="route-track" aria-hidden="true">
            <span className="route-rail" />
            <span className="route-fill" style={{ width: `${drawn * 100}%` }} />
            <span className="route-ship" style={{ left: `${drawn * 100}%` }}><Boat size={15} weight="fill" /></span>
          </div>
          <div className="route-end route-end-right">
            <span className="label"><span className="route-pin route-pin-dest" />Destination</span>
            <strong>{shipment.destination}</strong>
          </div>
        </div>
      </article>

      <div className="stats">
        {stats.map(({ icon: Icon, label, value, hint }) => (
          <div className="stat reveal" key={label}>
            <span className="stat-icon"><Icon size={18} /></span>
            <span className="label">{label}</span>
            <strong>{value}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>

      <div className="results-grid">
        <section className="panel reveal">
          <div className="panel-head">
            <div><h3>Shipment journey</h3><p>Milestones reported by the tracking provider</p></div>
            <span className="count-chip">{shipment.events.length} events</span>
          </div>
          <EventTimeline events={shipment.events} />
        </section>

        <aside className="side-stack">
          <div className="panel reveal">
            <div className="panel-head">
              <div><h3>Containers</h3><p>Associated equipment</p></div>
              <Cube size={18} className="muted-icon" />
            </div>
            {shipment.containers.length ? (
              <ul className="container-list">
                {shipment.containers.map((number) => (
                  <li key={number}><Cube size={16} /><span>{number}</span><CheckCircle size={16} weight="fill" className="ok-icon" /></li>
                ))}
              </ul>
            ) : <p className="muted-text">No container numbers returned for this shipment.</p>}
          </div>

          <div className="panel panel-excel reveal">
            <span className="tile tile-excel"><FileXls size={20} weight="fill" /></span>
            <h3>Keep the register current</h3>
            <p>“Update in Excel” writes the carrier, containers, ports and vessel dates for this BL into the workbook. Download the file any time afterwards.</p>
            <div className="panel-actions">
              <DownloadExcelButton variant="secondary" />
              <button className="btn btn-ghost" onClick={onOpenRegister}>Open register <ArrowRight size={15} /></button>
            </div>
          </div>

          <p className="fine-print"><WarningCircle size={14} />Carriers publish events periodically. Refreshing requests the latest provider data; it is not live GPS positioning.</p>
        </aside>
      </div>
    </section>
  );
}

function Overview({ recent, onPickRecent, onClearRecent }) {
  const features = [
    { icon: Path, title: "Journey milestones", text: "Every reported event and location, in chronological order." },
    { icon: Cube, title: "Container details", text: "Container references and equipment returned by the carrier." },
    { icon: FileXls, title: "Excel register", text: "Write tracking results into the shared workbook, then download it." }
  ];
  return (
    <section className="overview">
      <div className="section-row reveal">
        <div>
          <span className="eyebrow"><span className="eyebrow-bar" />Overview</span>
          <h2 className="section-heading">Shipment visibility, at a glance.</h2>
        </div>
      </div>
      <div className="features">
        {features.map(({ icon: Icon, title, text }, index) => (
          <div className="feature reveal" key={title} style={{ "--delay": `${index * 40}ms` }}>
            <span className="feature-index">0{index + 1}</span>
            <Icon size={24} className="feature-icon" />
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>

      {recent.length > 0 && (
        <div className="panel recent reveal">
          <div className="panel-head">
            <div><h3>Recent searches</h3><p>Saved in this browser only</p></div>
            <button className="text-button" onClick={onClearRecent}>Clear history</button>
          </div>
          <ul className="recent-list">
            {recent.map((item) => (
              <li key={item.bl}>
                <button className="recent-row" onClick={() => onPickRecent(item)}>
                  <span className="tile tile-soft"><ClockCounterClockwise size={17} /></span>
                  <span className="recent-text">
                    <strong>{item.bl}</strong>
                    <small>{item.carrier || "Auto-detect"} · {timeAgo(item.searchedAt)}</small>
                  </span>
                  <span className={`status status-sm status-${statusTone(item.status)}`}>{item.status}</span>
                  <ArrowUpRight size={16} className="recent-arrow" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------- Excel view ---------- */

function ExcelView({ excel, onReload, onTrackBl, onSync, savingExcel, notice, onDismissNotice, highlightRows }) {
  const [filter, setFilter] = useState("tracked");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [syncBl, setSyncBl] = useState("");
  const [syncCarrier, setSyncCarrier] = useState("");
  const { data, loading, error } = excel;

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.rows
      .filter((row) => (filter === "tracked" ? row.hasBL : true))
      .filter((row) => !needle || Object.values(row.values).some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .slice()
      .reverse();
  }, [data, filter, query]);

  useEffect(() => setLimit(40), [filter, query]);
  useReveal([data, rows.length]);

  const canSync = syncBl.trim().length >= 5 && !savingExcel;

  return (
    <section className="excel-view">
      <div className="results-head reveal">
        <div>
          <span className="eyebrow"><span className="eyebrow-bar" />Workspace · Excel</span>
          <h1 className="page-title">Excel register</h1>
          <p className="page-sub">The workbook every “Update in Excel” writes to. Download it whenever you need the latest copy.</p>
        </div>
        <div className="results-actions">
          <button className="btn btn-secondary" onClick={onReload} disabled={loading}>
            {loading ? <Spinner /> : <ArrowsClockwise size={16} />} Reload
          </button>
          <DownloadExcelButton label="Download .xlsx" />
        </div>
      </div>

      <ExcelNotice notice={notice} onDismiss={onDismissNotice} />

      {error && !data && (
        <div className="panel empty-inline is-error reveal">
          <WarningCircle size={22} />
          <div><strong>Could not load the workbook</strong><p>{error}</p></div>
        </div>
      )}

      {data && (
        <>
          <div className="file-card reveal">
            <span className="tile tile-excel tile-lg"><FileXls size={26} weight="fill" /></span>
            <div className="file-meta">
              <strong>{data.fileName}</strong>
              <span>Sheet “{data.sheetName}” · {formatBytes(data.sizeBytes)} · saved {timeAgo(data.modifiedAt)}</span>
            </div>
            <dl className="file-stats">
              <div><dt>Records</dt><dd>{data.totalRecords}</dd></div>
              <div><dt>With BL</dt><dd>{data.trackedRecords}</dd></div>
              <div><dt>Last saved</dt><dd>{new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(data.modifiedAt))}</dd></div>
            </dl>
          </div>

          <form
            className="sync-card reveal"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!canSync) return;
              const ok = await onSync(syncBl.trim().replace(/\s+/g, ""), syncCarrier);
              if (ok) setSyncBl("");
            }}
          >
            <div className="sync-copy">
              <h3>Sync a BL to Excel</h3>
              <p>Fetch the latest tracking data and write it to the matching row, or add a new row.</p>
            </div>
            <div className="field">
              <MagnifyingGlass size={18} className="field-icon" />
              <input value={syncBl} onChange={(event) => setSyncBl(event.target.value)} placeholder="BL number" aria-label="BL number to sync" autoComplete="off" spellCheck="false" />
            </div>
            <CarrierSelect id="sync-carrier" value={syncCarrier} onChange={setSyncCarrier} />
            <button type="submit" className="btn btn-excel" disabled={!canSync}>
              {savingExcel ? <Spinner /> : <FileXls size={17} weight="fill" />} {savingExcel ? "Updating…" : "Update in Excel"}
            </button>
          </form>

          <div className="panel table-panel reveal">
            <div className="table-toolbar">
              <div className="segmented" role="tablist">
                <button role="tab" aria-selected={filter === "tracked"} className={filter === "tracked" ? "on" : ""} onClick={() => setFilter("tracked")}>
                  With BL <span>{data.trackedRecords}</span>
                </button>
                <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
                  All records <span>{data.totalRecords}</span>
                </button>
              </div>
              <div className="field field-sm">
                <MagnifyingGlass size={16} className="field-icon" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search BL, container, port…" aria-label="Search register" />
                {query && <button className="icon-button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
              </div>
            </div>

            <div className="table-scroll">
              <table className="register">
                <thead>
                  <tr>
                    <th className="col-row">Row</th>
                    {REGISTER_TABLE.map((col) => <th key={col.key}>{col.label}</th>)}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((row) => {
                    const bl = row.values["BL NUMBER"];
                    return (
                      <tr key={row.row} className={highlightRows.includes(row.row) ? "is-updated" : ""}>
                        <td className="col-row">{row.row}</td>
                        {REGISTER_TABLE.map((col) => {
                          const raw = row.values[col.key];
                          const value = raw === null || raw === undefined || raw === "" ? null : col.date ? formatDate(raw, "") : String(raw);
                          return (
                            <td key={col.key} className={`${col.mono ? "mono" : ""} ${col.clamp ? "clamp" : ""}`} title={col.clamp && value ? value : undefined}>
                              {value ?? <span className="nil">—</span>}
                            </td>
                          );
                        })}
                        <td className="col-action">
                          {row.hasBL ? (
                            <button className="row-action" onClick={() => onTrackBl(String(bl))} aria-label={`Track ${bl}`}>
                              Track <ArrowUpRight size={14} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!rows.length && (
                <div className="empty-inline table-empty">
                  <Table size={22} />
                  <div><strong>No matching rows</strong><p>Try a different search or switch to “All records”.</p></div>
                </div>
              )}
            </div>

            <div className="table-foot">
              <span>Showing {Math.min(limit, rows.length)} of {rows.length} · newest rows first</span>
              {rows.length > limit && <button className="btn btn-secondary btn-sm" onClick={() => setLimit((n) => n + 60)}>Show more</button>}
            </div>
          </div>
        </>
      )}

      {loading && !data && <LoadingPanel />}
    </section>
  );
}

/* ---------- Shipment summary view ---------- */

function EtaCell({ entry }) {
  if (!entry || entry.loading) return <span className="eta-pending"><Spinner size={13} /> Fetching…</span>;
  if (entry.error) return <span className="nil" title={entry.error}>Unavailable</span>;
  return entry.eta ? formatDateTime(entry.eta) : <span className="nil">—</span>;
}

function SummaryView({ bls, onAddBls, onRemoveBl, etas, onRefreshEtas, onTrackBl, onOpenRegister }) {
  const [input, setInput] = useState("");
  const [summary, setSummary] = useState({ data: null, loading: false, error: "" });
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const loadSummary = useCallback(async () => {
    if (!bls.length) {
      setSummary({ data: null, loading: false, error: "" });
      return;
    }
    setSummary((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const params = new URLSearchParams({ bl_numbers: bls.join(",") });
      const data = await apiRequest(`/api/shipment-summary?${params.toString()}`);
      setSummary({ data, loading: false, error: "" });
    } catch (err) {
      setSummary((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, [bls]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useReveal([summary.data]);

  // One row per BL; the backend merges the BL's workbook rows into lists of distinct values.
  const tableRows = useMemo(() => {
    const byBl = new Map((summary.data?.shipments || []).map((item) => [item.bl, item]));
    return bls.map((bl) => {
      const match = byBl.get(bl);
      const values = match?.values || {};
      return {
        bl,
        values,
        inRegister: Boolean(match?.rows.length),
        missing: Boolean(match && !match.rows.length),
        savedAmount: values["CHEQUE AMOUNT"]?.[0] ?? null
      };
    });
  }, [bls, summary.data]);

  const changes = tableRows
    .filter((item) => item.inRegister && item.bl in drafts && parseAmount(drafts[item.bl]) !== item.savedAmount)
    .map((item) => ({ bl: item.bl, amount: parseAmount(drafts[item.bl]) }));
  const invalid = changes.some((change) => Number.isNaN(change.amount));

  function stopEditing(blList) {
    setDrafts((prev) => {
      const next = { ...prev };
      blList.forEach((bl) => delete next[bl]);
      return next;
    });
  }

  async function saveAmounts(updates = changes) {
    if (!updates.length || updates.some((update) => Number.isNaN(update.amount))) return;
    setSaving(true);
    setNotice(null);
    try {
      const payload = await apiRequest("/api/shipment-summary/cheque-amounts", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ updates })
      });
      setNotice({
        type: "success",
        title: updates.length === 1 ? `Cheque amount saved for BL ${updates[0].bl}` : `Saved ${updates.length} cheque amounts to Excel`,
        text: `${payload.fileName ?? "Workbook"} · row ${(payload.rowsUpdated || []).join(", ")}`
      });
      await loadSummary();
      stopEditing(updates.map((update) => update.bl));
    } catch (err) {
      setNotice({ type: "error", text: err.message || "Could not save cheque amounts." });
    } finally {
      setSaving(false);
    }
  }

  function onAmountKeyDown(event, item) {
    if (event.key === "Escape") {
      stopEditing([item.bl]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const amount = parseAmount(drafts[item.bl]);
      if (amount === item.savedAmount) stopEditing([item.bl]);
      else saveAmounts([{ bl: item.bl, amount }]);
    }
  }

  function addFromInput(event) {
    event.preventDefault();
    const next = splitBls(input);
    if (!next.length) return;
    onAddBls(next);
    setInput("");
  }

  return (
    <section className="excel-view">
      <div className="results-head reveal">
        <div>
          <span className="eyebrow"><span className="eyebrow-bar" />Workspace · Summary</span>
          <h1 className="page-title">Shipment summary</h1>
          <p className="page-sub">Customs and agent details from the Excel register for every BL you add, with the latest arrival estimate from the carrier.</p>
        </div>
        <div className="results-actions">
          <button className="btn btn-secondary" onClick={() => { loadSummary(); onRefreshEtas(); }} disabled={summary.loading || !bls.length}>
            {summary.loading ? <Spinner /> : <ArrowsClockwise size={16} />} Refresh
          </button>
          <button className="btn btn-excel" onClick={() => saveAmounts()} disabled={saving || !changes.length || invalid}>
            {saving ? <Spinner /> : <FileXls size={17} weight="fill" />}
            {saving ? "Updating Excel…" : `Update in Excel${changes.length ? ` (${changes.length})` : ""}`}
          </button>
        </div>
      </div>

      <ExcelNotice notice={notice} onDismiss={() => setNotice(null)} onOpenRegister={onOpenRegister} />

      <form className="sync-card summary-add reveal" onSubmit={addFromInput}>
        <div className="sync-copy">
          <h3>Add BL numbers</h3>
          <p>Paste one or several, separated by commas, spaces or new lines.</p>
        </div>
        <div className="field">
          <MagnifyingGlass size={18} className="field-icon" />
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="e.g. MEDUH9197102, DXB1014423" aria-label="BL numbers to add" autoComplete="off" spellCheck="false" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!splitBls(input).length}>
          Add to summary <ArrowRight size={16} weight="bold" />
        </button>
      </form>

      {summary.error && (
        <div className="panel empty-inline is-error reveal">
          <WarningCircle size={22} />
          <div><strong>Could not load the summary</strong><p>{summary.error}</p></div>
        </div>
      )}

      <div className="panel table-panel reveal">
        <div className="table-scroll">
          <table className="register">
            <thead>
              <tr>
                <th>BL number</th>
                <th>EST number</th>
                <th>Est. arrival</th>
                <th>Exit number</th>
                <th>Cheque amount</th>
                <th>Agent name</th>
                <th>Vessel ETA</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tableRows.map((item) => {
                const editing = item.inRegister && (item.bl in drafts || item.savedAmount === null);
                const text = drafts[item.bl] ?? "";
                const parsed = parseAmount(text);
                const cell = (key, date) => {
                  const list = item.values[key] || [];
                  if (!list.length) return <span className="nil">—</span>;
                  return list.map((value) => <span className="cell-line" key={value}>{date ? formatDate(value, "") : String(value)}</span>);
                };
                return (
                  <tr key={item.bl}>
                    <td className="mono">
                      {item.bl}
                      {item.missing && <span className="chip summary-missing">Not in register</span>}
                    </td>
                    <td>{cell("EST NUMBER")}</td>
                    <td><EtaCell entry={etas[item.bl]} /></td>
                    <td>{cell("Exit No")}</td>
                    <td>
                      {!item.inRegister ? <span className="nil">—</span> : editing ? (
                        <input
                          className={`amount-input ${parsed !== item.savedAmount && text !== "" ? "is-dirty" : ""} ${Number.isNaN(parsed) ? "is-invalid" : ""}`}
                          value={text}
                          inputMode="decimal"
                          placeholder="0.00"
                          autoFocus={item.bl in drafts && item.savedAmount !== null}
                          disabled={saving}
                          aria-label={`Cheque amount for BL ${item.bl}. Press Enter to save.`}
                          title="Press Enter to save, Esc to cancel"
                          onChange={(event) => setDrafts((prev) => ({ ...prev, [item.bl]: event.target.value }))}
                          onKeyDown={(event) => onAmountKeyDown(event, item)}
                        />
                      ) : (
                        <span className="amount-saved">
                          {AMOUNT_FORMAT.format(item.savedAmount)}
                          <button
                            className="icon-button amount-edit"
                            onClick={() => setDrafts((prev) => ({ ...prev, [item.bl]: String(item.savedAmount) }))}
                            aria-label={`Edit cheque amount for BL ${item.bl}`}
                            title="Edit"
                          >
                            <PencilSimple size={14} />
                          </button>
                        </span>
                      )}
                    </td>
                    <td>{cell("Agent Name")}</td>
                    <td>{cell("VESSEL ETA", true)}</td>
                    <td className="col-action">
                      <button className="row-action" onClick={() => onTrackBl(item.bl)} aria-label={`Track ${item.bl}`}>
                        Track <ArrowUpRight size={14} />
                      </button>
                      <button className="row-action" onClick={() => onRemoveBl(item.bl)} aria-label={`Remove ${item.bl} from summary`}>
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!bls.length && (
            <div className="empty-inline table-empty">
              <Bookmarks size={22} />
              <div><strong>No shipments yet</strong><p>Add BL numbers above to build your summary. The list is kept in this browser.</p></div>
            </div>
          )}
        </div>
        <div className="table-foot">
          <span>{bls.length} BL{bls.length === 1 ? "" : "s"} · press Enter in a cheque amount to save it</span>
          {invalid && <span className="summary-invalid">Cheque amounts must be numbers with up to 2 decimals.</span>}
        </div>
      </div>
    </section>
  );
}

/* ---------- Payment alerts ---------- */

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readSnoozes() {
  try { return JSON.parse(localStorage.getItem(PAYMENT_SNOOZE_KEY) || "{}"); }
  catch { return {}; }
}

function arrivalText(daysLeft) {
  if (daysLeft > 1) return `arrives in ${daysLeft} days`;
  if (daysLeft === 1) return "arrives tomorrow";
  if (daysLeft === 0) return "arrives today";
  return `arrived ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
}

/* Asks for payment on every BL arriving within the threshold until it is marked received.
   "Not yet" hides a BL for the rest of the day; the popup returns the next day. */
function PaymentAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [threshold, setThreshold] = useState(15);
  const [busyBl, setBusyBl] = useState("");
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    try {
      const data = await apiRequest("/api/payment-alerts");
      const snoozes = readSnoozes();
      const today = localDay();
      setThreshold(data.thresholdDays);
      setAlerts(data.alerts.filter((alert) => snoozes[alert.bl] !== today));
    } catch {
      // The alert is a reminder only; a failed check is retried on the next interval.
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, PAYMENT_CHECK_MS);
    return () => clearInterval(id);
  }, [check]);

  function dismiss(bl) {
    setAlerts((prev) => prev.filter((alert) => alert.bl !== bl));
  }

  function notYet(bl) {
    const today = localDay();
    // Drop snoozes from earlier days so the stored map stays small.
    const kept = Object.fromEntries(Object.entries(readSnoozes()).filter(([, day]) => day === today));
    try { localStorage.setItem(PAYMENT_SNOOZE_KEY, JSON.stringify({ ...kept, [bl]: today })); } catch { /* storage unavailable */ }
    dismiss(bl);
  }

  async function received(bl) {
    setBusyBl(bl);
    setError("");
    try {
      await apiRequest("/api/payment-alerts/received", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ bl })
      });
      dismiss(bl);
    } catch (err) {
      setError(err.message || "Could not save the payment status.");
    } finally {
      setBusyBl("");
    }
  }

  if (!alerts.length) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="payment-title">
        <div className="modal-head">
          <span className="tile tile-brand"><Bell size={20} weight="fill" /></span>
          <div>
            <h2 id="payment-title">{alerts.length === 1 ? "Shipment arriving soon" : `${alerts.length} shipments arriving soon`}</h2>
            <p>Arrival is {threshold} days away or less. Request payment from the consignee.</p>
          </div>
        </div>

        <ul className="payment-list">
          {alerts.map((alert) => (
            <li key={alert.bl} className="payment-item">
              <div className="payment-info">
                <strong className="mono">{alert.bl}</strong>
                <span>
                  {alert.consignee || "Consignee not recorded"}
                  {alert.shippingLine ? ` · ${alert.shippingLine}` : ""}
                </span>
                <span className={`chip ${alert.daysLeft <= 3 ? "chip-urgent" : "chip-brand"}`}>
                  <CalendarBlank size={13} /> {formatDate(alert.eta)} · {arrivalText(alert.daysLeft)}
                </span>
              </div>
              <div className="payment-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => notYet(alert.bl)} disabled={busyBl === alert.bl}>
                  Not yet
                </button>
                <button className="btn btn-excel btn-sm" onClick={() => received(alert.bl)} disabled={Boolean(busyBl)}>
                  {busyBl === alert.bl ? <Spinner size={14} /> : <CheckCircle size={15} weight="fill" />} Payment received
                </button>
              </div>
            </li>
          ))}
        </ul>

        {error && (
          <div className="inline-error" role="alert">
            <WarningCircle size={18} weight="fill" />
            <span>{error}</span>
          </div>
        )}
        <p className="modal-foot">“Not yet” reminds you again tomorrow. “Payment received” is saved to the Excel register.</p>
      </div>
    </div>
  );
}

/* ---------- App ---------- */

export default function App() {
  const [view, setView] = useState(() => {
    const hash = window.location.hash.slice(1);
    return hash in VIEW_LABELS ? hash : "track";
  });
  const [blNumber, setBlNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [shipment, setShipment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastSearched, setLastSearched] = useState("");
  const [savingExcel, setSavingExcel] = useState(false);
  const [notice, setNotice] = useState(null);
  const [highlightRows, setHighlightRows] = useState([]);
  const [health, setHealth] = useState(null);
  const [excel, setExcel] = useState({ data: null, loading: false, error: "" });
  const resultsRef = useRef(null);
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || localStorage.getItem("freightline-recent") || "[]"); }
    catch { return []; }
  });

  const [summaryBls, setSummaryBls] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SUMMARY_KEY) || "[]"); }
    catch { return []; }
  });
  // Tracking lookups per BL, kept here so switching views does not re-query the provider.
  const [etas, setEtas] = useState({});

  useEffect(() => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5))); } catch { /* storage unavailable */ }
  }, [recent]);

  useEffect(() => {
    try { localStorage.setItem(SUMMARY_KEY, JSON.stringify(summaryBls)); } catch { /* storage unavailable */ }
  }, [summaryBls]);

  // Fetch the provider ETA for summary BLs that have not been looked up yet, a few at a time.
  useEffect(() => {
    if (view !== "summary") return;
    const pending = summaryBls.filter((bl) => !etas[bl]);
    if (!pending.length) return;
    setEtas((prev) => Object.fromEntries([...Object.entries(prev), ...pending.map((bl) => [bl, { loading: true }])]));
    const queue = [...pending];
    const worker = async () => {
      while (queue.length) {
        const bl = queue.shift();
        let entry;
        try {
          const payload = await apiRequest(`/api/track?${new URLSearchParams({ bl_number: bl }).toString()}`);
          entry = { eta: normalizeResponse(payload, bl, "").eta };
        } catch (err) {
          entry = { error: err.message };
        }
        setEtas((prev) => (prev[bl] ? { ...prev, [bl]: entry } : prev));
      }
    };
    Array.from({ length: Math.min(3, pending.length) }, worker);
  }, [view, summaryBls, etas]);

  useEffect(() => {
    fetch("/api/health").then((r) => (r.ok ? r.json() : false)).then(setHealth).catch(() => setHealth(false));
  }, []);

  const loadExcel = useCallback(async () => {
    setExcel((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const data = await apiRequest("/api/excel");
      setExcel({ data, loading: false, error: "" });
    } catch (err) {
      setExcel((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => { loadExcel(); }, [loadExcel]);

  useReveal([view, shipment, loading]);

  function navigate(next) {
    if (next === view) return;
    setView(next);
    window.history.replaceState(null, "", next === "track" ? "#" : `#${next}`);
    scrollToTop({ immediate: true });
    if (next === "excel") loadExcel();
  }

  async function trackShipment(value = blNumber, carrierValue = carrier) {
    const cleaned = value.trim().replace(/\s+/g, "");
    if (cleaned.length < 5) {
      setError("Enter a valid Bill of Lading number (at least 5 characters).");
      return;
    }
    setBlNumber(cleaned);
    setLoading(true);
    setError("");
    setNotice(null);
    setShipment(null);
    setLastSearched(cleaned);
    try {
      const params = new URLSearchParams({ bl_number: cleaned });
      if (carrierValue) params.set("carrier", carrierValue);
      const payload = await apiRequest(`/api/track?${params.toString()}`);
      const normalized = normalizeResponse(payload, cleaned, carrierValue);
      setShipment(normalized);
      setRecent((previous) => [
        { bl: cleaned, carrier: carrierValue, status: normalized.status, searchedAt: new Date().toISOString() },
        ...previous.filter((item) => item.bl !== cleaned)
      ].slice(0, 5));
      requestAnimationFrame(() => scrollToElement(resultsRef.current));
    } catch (err) {
      setError(err.message || "Something went wrong while tracking this shipment.");
    } finally {
      setLoading(false);
    }
  }

  async function syncToExcel(bl, carrierValue) {
    setSavingExcel(true);
    setNotice(null);
    try {
      const params = new URLSearchParams({ bl_number: bl });
      if (carrierValue) params.set("carrier", carrierValue);
      const payload = await apiRequest(`/api/update-excel?${params.toString()}`, { method: "POST" });
      setHighlightRows(payload.rowsUpdated || []);
      setNotice({
        type: "success",
        title: payload.action === "created" ? `BL ${bl} added to Excel` : `Excel updated for BL ${bl}`,
        text: `${payload.fileName ?? "Workbook"} · row ${(payload.rowsUpdated || []).join(", ")}${payload.fieldsUpdated?.length ? ` · ${payload.fieldsUpdated.join(", ")}` : ""}`
      });
      loadExcel();
      return true;
    } catch (err) {
      setNotice({ type: "error", text: err.message || "Could not update Excel." });
      return false;
    } finally {
      setSavingExcel(false);
    }
  }

  function clearSearch() {
    setShipment(null);
    setError("");
    setNotice(null);
    setBlNumber("");
    setLastSearched("");
    scrollToTop();
  }

  function trackFromRegister(bl) {
    setView("track");
    window.history.replaceState(null, "", "#");
    setCarrier("");
    scrollToTop({ immediate: true });
    trackShipment(bl, "");
  }

  return (
    <div className="app">
      <Sidebar view={view} onNavigate={navigate} excelCount={excel.data?.trackedRecords} summaryCount={summaryBls.length} />

      <main className="main">
        <Topbar view={view} health={health} />

        <div className="page" key={view}>
          {view === "track" ? (
            <>
              <SearchHero
                blNumber={blNumber}
                setBlNumber={setBlNumber}
                carrier={carrier}
                setCarrier={setCarrier}
                loading={loading}
                error={error}
                onDismissError={() => setError("")}
                onSubmit={() => trackShipment()}
              />

              <div ref={resultsRef}>
                {loading && <LoadingPanel />}
                {shipment && !loading && (
                  <ShipmentResults
                    shipment={shipment}
                    refreshing={loading}
                    onRefresh={() => trackShipment(lastSearched, carrier)}
                    onClear={clearSearch}
                    onUpdateExcel={() => syncToExcel(shipment.shipmentNumber || lastSearched, carrier)}
                    savingExcel={savingExcel}
                    notice={notice}
                    onDismissNotice={() => setNotice(null)}
                    onOpenRegister={() => navigate("excel")}
                  />
                )}
                {!shipment && !loading && (
                  <Overview
                    recent={recent}
                    onPickRecent={(item) => { setCarrier(item.carrier || ""); trackShipment(item.bl, item.carrier || ""); }}
                    onClearRecent={() => setRecent([])}
                  />
                )}
              </div>
            </>
          ) : view === "summary" ? (
            <SummaryView
              bls={summaryBls}
              onAddBls={(next) => setSummaryBls((prev) => [...new Set([...prev, ...next])])}
              onRemoveBl={(bl) => {
                setSummaryBls((prev) => prev.filter((item) => item !== bl));
                setEtas(({ [bl]: _removed, ...rest }) => rest);
              }}
              etas={etas}
              onRefreshEtas={() => setEtas({})}
              onTrackBl={trackFromRegister}
              onOpenRegister={() => navigate("excel")}
            />
          ) : (
            <ExcelView
              excel={excel}
              onReload={loadExcel}
              onTrackBl={trackFromRegister}
              onSync={syncToExcel}
              savingExcel={savingExcel}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              highlightRows={highlightRows}
            />
          )}

          <footer className="page-footer">
            <span>© {new Date().getFullYear()} Kenzol · Shipping Tracking</span>
            <span>Tracking data supplied by external carrier/provider APIs</span>
          </footer>
        </div>
      </main>

      <PaymentAlerts />
    </div>
  );
}
