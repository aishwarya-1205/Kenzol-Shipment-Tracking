import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ArrowsClockwise, CaretDown, CheckCircle, MagnifyingGlass, WarningCircle, X } from "@phosphor-icons/react";
import { ALERT_DAYS, CARRIERS, formatAmount, formatDate, parseAmount, relativeDays, updateShipment } from "./lib.js";

export function Spinner({ size = 15 }) {
  return <ArrowsClockwise size={size} className="spin" aria-hidden="true" />;
}

export function Notice({ notice, onDismiss, children }) {
  if (!notice) return null;
  const ok = notice.type === "success";
  return (
    <div className={`notice ${ok ? "" : "notice-error"}`} role="status">
      {ok ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
      <div className="notice-body">
        <strong>{notice.title || (ok ? "Done" : "Something went wrong")}</strong>
        {notice.text && <span>{notice.text}</span>}
        {children}
      </div>
      <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

export function SearchField({ value, onChange, placeholder, label }) {
  return (
    <label className="search">
      <MagnifyingGlass size={15} aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label || placeholder} />
      {value && <button type="button" className="icon-btn" onClick={() => onChange("")} aria-label="Clear search"><X size={13} /></button>}
    </label>
  );
}

export function CarrierSelect({ id, value, onChange }) {
  return (
    <div className="select">
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-label="Shipping line">
        {CARRIERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <CaretDown size={12} aria-hidden="true" />
    </div>
  );
}

export function Nil() {
  return <span className="nil">—</span>;
}

// Register ETAs are estimates: "ETA passed" is shown rather than "arrived", because
// arrival is only known once the carrier confirms it on the Track page.
export function EtaText({ eta, days }) {
  if (!eta) return <Nil />;
  if (days === null || days === undefined) return <span title="Not a date in the register">{eta}</span>;
  const soon = days >= 0 && days <= ALERT_DAYS;
  return (
    <span className="stack">
      <span>{formatDate(eta)}</span>
      <small className={soon ? "text-accent" : "muted"}>{days < 0 ? `ETA passed ${relativeDays(days)}` : relativeDays(days)}</small>
    </span>
  );
}

export function TelexBadge({ shipment }) {
  if (!shipment.bl) return <Nil />;
  const released = shipment.telexStatus === "Released";
  return <span className={`badge ${released ? "badge-ok" : "badge-wait"}`}>{released ? "Released" : "Pending"}</span>;
}

const COLUMNS = {
  est: { label: "EST no.", cell: (s) => s.est || <Nil /> },
  date: { label: "Date", cell: (s) => (s.date ? formatDate(s.date) : <Nil />), nowrap: true },
  exitNo: { label: "Exit no.", cell: (s) => s.exitNo || <Nil />, mono: true },
  cheque: {
    label: "Cheque no. / amount",
    cell: (s) => (s.chequeNumber || s.chequeAmount !== null ? (
      <span className="stack">
        <span>{s.chequeNumber || "—"}</span>
        <small className="muted">{s.chequeAmount !== null ? formatAmount(s.chequeAmount) : "No amount"}</small>
      </span>
    ) : <Nil />)
  },
  agent: { label: "Agent", cell: (s) => s.agent || <Nil />, clamp: true },
  consignee: { label: "Consignee", cell: (s) => s.consignee || <Nil />, clamp: true },
  destination: { label: "Destination", cell: (s) => s.destination || <Nil />, clamp: true },
  type: { label: "Type", cell: (s) => (s.type ? s.type : <span className="muted" title="Type not recorded; category worked out from the destination">Not recorded</span>) },
  eta: { label: "Vessel ETA", cell: (s) => <EtaText eta={s.eta} days={s.etaDays} />, nowrap: true },
  bl: { label: "BL number", cell: (s) => s.bl || <Nil />, mono: true },
  telex: { label: "Telex", cell: (s) => <TelexBadge shipment={s} /> }
};

const PAGE = 50;

export function ShipmentTable({ rows, columns, onOpen, onTrack, empty = "No shipments match." }) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [rows]);
  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {columns.map((key) => <th key={key}>{COLUMNS[key].label}</th>)}
              {onTrack && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((s) => (
              <tr key={s.row} className={onOpen ? "is-clickable" : ""} onClick={onOpen ? () => onOpen(s) : undefined}>
                {columns.map((key) => {
                  const col = COLUMNS[key];
                  return <td key={key} className={[col.mono && "mono", col.clamp && "clamp", col.nowrap && "nowrap"].filter(Boolean).join(" ")}>{col.cell(s)}</td>;
                })}
                {onTrack && (
                  <td className="cell-action">
                    {s.bl && (
                      <button className="link-btn" onClick={(event) => { event.stopPropagation(); onTrack(s.bl); }}>
                        Track <ArrowUpRight size={13} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty">{empty}</p>}
      </div>
      {rows.length > 0 && (
        <div className="table-foot">
          <span>{Math.min(limit, rows.length)} of {rows.length}</span>
          {rows.length > limit && <button className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE * 2)}>Show more</button>}
        </div>
      )}
    </div>
  );
}

/* ---------- Row detail drawer ---------- */

function Detail({ label, children }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{children || <Nil />}</dd>
    </div>
  );
}

function formFrom(shipment) {
  return {
    chequeAmount: shipment.chequeAmount === null ? "" : String(shipment.chequeAmount),
    refundDate: /^\d{4}-\d{2}-\d{2}$/.test(shipment.refundDate || "") ? shipment.refundDate : "",
    refundReceived: shipment.refundStatus === "Received",
    telexStatus: shipment.telexStatus === "Released" ? "Released" : "Pending",
    paymentReceived: shipment.paymentStatus === "Received"
  };
}

export function ShipmentDrawer({ shipment, onClose, onSaved, onTrack }) {
  const [form, setForm] = useState(() => formFrom(shipment));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef(null);

  useEffect(() => {
    setForm(formFrom(shipment));
    setError("");
  }, [shipment]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const initial = useMemo(() => formFrom(shipment), [shipment]);
  const amount = parseAmount(form.chequeAmount);
  const changes = {};
  if (form.chequeAmount !== initial.chequeAmount && !Number.isNaN(amount)) changes.chequeAmount = amount;
  if (form.refundDate !== initial.refundDate) changes.refundDate = form.refundDate || null;
  if (form.refundReceived !== initial.refundReceived) changes.refundStatus = form.refundReceived ? "Received" : null;
  if (shipment.bl && form.telexStatus !== initial.telexStatus) changes.telexStatus = form.telexStatus;
  if (form.paymentReceived !== initial.paymentReceived) changes.paymentStatus = form.paymentReceived ? "Received" : null;
  const dirty = Object.keys(changes).length > 0;

  async function save(event) {
    event.preventDefault();
    if (!dirty || Number.isNaN(amount)) return;
    setSaving(true);
    setError("");
    try {
      await updateShipment(shipment.row, changes);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <div>
            <span className="eyebrow">Row {shipment.row}{shipment.type ? ` · ${shipment.type}` : ""}</span>
            <h2 id="drawer-title" className="mono">{shipment.bl || shipment.exitNo || "No BL number"}</h2>
          </div>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="drawer-body">
          <dl className="details">
            <Detail label="EST no.">{shipment.est}</Detail>
            <Detail label="Date">{formatDate(shipment.date)}</Detail>
            <Detail label="Exit no.">{shipment.exitNo}</Detail>
            <Detail label="Cheque no.">{shipment.chequeNumber}</Detail>
            <Detail label="Agent">{shipment.agent}</Detail>
            <Detail label="Consignee">{shipment.consignee}</Detail>
            <Detail label="Loading point">{shipment.origin}</Detail>
            <Detail label="Destination">{shipment.destination}</Detail>
            <Detail label="Shipping line">{shipment.shippingLine}</Detail>
            <Detail label="Vessel ETD">{formatDate(shipment.etd)}</Detail>
            <Detail label="Vessel ETA">{shipment.eta && <EtaText eta={shipment.eta} days={shipment.etaDays} />}</Detail>
            <Detail label="Containers">{shipment.containers}</Detail>
          </dl>

          <form className="drawer-form" onSubmit={save}>
            <h3>Update</h3>
            <div className="form-grid">
              <label className="form-field">
                <span>Cheque amount</span>
                <input className={Number.isNaN(amount) ? "is-invalid" : ""} value={form.chequeAmount} onChange={set("chequeAmount")} inputMode="decimal" placeholder="0.00" />
              </label>
              <label className="form-field">
                <span>Cheque refund due</span>
                <input type="date" value={form.refundDate} onChange={set("refundDate")} />
              </label>
            </div>
            {shipment.bl && (
              <div className="form-field">
                <span>Telex status <small className="muted">applies to every row of this BL</small></span>
                <div className="segmented" role="radiogroup" aria-label="Telex status">
                  {["Pending", "Released"].map((value) => (
                    <button type="button" key={value} role="radio" aria-checked={form.telexStatus === value} className={form.telexStatus === value ? "on" : ""} onClick={() => setForm((prev) => ({ ...prev, telexStatus: value }))}>
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={form.paymentReceived} onChange={set("paymentReceived")} />
              <span>Payment received from consignee</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.refundReceived} onChange={set("refundReceived")} />
              <span>Cheque refund received</span>
            </label>
            {Number.isNaN(amount) && <p className="form-error">Cheque amount must be a number with up to 2 decimals.</p>}
            {error && <p className="form-error">{error}</p>}
            <div className="drawer-actions">
              {shipment.bl && <button type="button" className="btn" onClick={() => onTrack(shipment.bl)}>Track BL <ArrowUpRight size={14} /></button>}
              <button type="submit" className="btn btn-primary" disabled={!dirty || saving || Number.isNaN(amount)}>
                {saving && <Spinner />} {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}
