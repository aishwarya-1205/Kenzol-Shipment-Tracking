import { useEffect, useRef, useState } from "react";
import { Bell, X } from "@phosphor-icons/react";
import { Spinner } from "./components.jsx";
import { formatAmount, formatDate, readStorage, relativeDays, updateShipment, writeStorage } from "./lib.js";

// Notification id -> local day ("YYYY-MM-DD") it was snoozed on; the popup asks again the next day.
const SNOOZE_KEY = "kenzol-notification-snooze";

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function when(item) {
  if (item.kind === "refund") return item.days < 0 ? `refund overdue since ${formatDate(item.date, { short: true })}` : `refund due ${formatDate(item.date, { short: true })}, ${relativeDays(item.days)}`;
  return item.days < 0 ? `ETA ${formatDate(item.date, { short: true })} passed ${relativeDays(item.days)}` : `ETA ${formatDate(item.date, { short: true })}, ${relativeDays(item.days)}`;
}

function NotificationItem({ item, busy, onDone, onSnooze, onOpen }) {
  const refund = item.kind === "refund";
  const title = refund
    ? `Cheque ${item.chequeNumber || `on row ${item.row}`}`
    : item.bl ? `BL ${item.bl}` : `Exit ${item.exitNo || `row ${item.row}`}`;
  const detail = refund
    ? [item.bl ? `BL ${item.bl}` : item.exitNo, item.chequeAmount !== null ? formatAmount(item.chequeAmount) : ""]
    : [item.consignee, item.agent];
  return (
    <li className="note">
      <button className="note-main" onClick={() => onOpen(item.row)}>
        <span className={`note-kind ${item.days <= 3 ? "is-urgent" : ""}`}>{refund ? "Refund" : "Arrival"}</span>
        <strong>{title}</strong>
        <span className={item.days <= 3 ? "text-accent" : ""}>{when(item)}</span>
        <small className="muted">{detail.filter(Boolean).join(" · ")}</small>
      </button>
      <div className="note-actions">
        {onSnooze && <button className="btn btn-sm btn-quiet" onClick={() => onSnooze(item.id)} disabled={busy}>Tomorrow</button>}
        <button className="btn btn-sm" onClick={() => onDone(item)} disabled={busy}>
          {busy && <Spinner size={13} />} {refund ? "Refund received" : "Payment received"}
        </button>
      </div>
    </li>
  );
}

export function useNotificationActions(onChanged) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  async function done(item) {
    setBusyId(item.id);
    setError("");
    try {
      await updateShipment(item.row, item.kind === "refund" ? { refundStatus: "Received" } : { paymentStatus: "Received" });
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }
  return { busyId, error, done };
}

/* Bell in the top bar: every open notification, snoozed or not. */
export function NotificationBell({ data, onChanged, onOpenRow }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { busyId, error, done } = useNotificationActions(onChanged);
  const items = data?.items || [];

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn bell-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Notifications (${items.length})`}>
        <Bell size={18} />
        {items.length > 0 && <span className="bell-count">{items.length}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <header className="popover-head">
            <strong>Notifications</strong>
            <small className="muted">Arrivals and cheque refunds within {data?.thresholdDays ?? 15} days</small>
          </header>
          {items.length ? (
            <ul className="note-list">
              {items.map((item) => (
                <NotificationItem key={item.id} item={item} busy={busyId === item.id} onDone={done} onOpen={(row) => { setOpen(false); onOpenRow(row); }} />
              ))}
            </ul>
          ) : <p className="empty">Nothing due. You're all caught up.</p>}
          {error && <p className="form-error popover-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/* Popup on arrival: asks about anything not snoozed today. */
export function NotificationPopup({ data, onChanged, onOpenRow }) {
  const [snoozes, setSnoozes] = useState(() => readStorage(SNOOZE_KEY, {}));
  const [closed, setClosed] = useState(false);
  const { busyId, error, done } = useNotificationActions(onChanged);
  const today = localDay();
  const items = (data?.items || []).filter((item) => snoozes[item.id] !== today);

  // A later check that finds new items reopens the popup.
  const ids = items.map((item) => item.id).join(",");
  useEffect(() => setClosed(false), [ids]);

  function snooze(ids) {
    // Only today's entries are kept so the stored map stays small.
    const kept = Object.fromEntries(Object.entries(snoozes).filter(([, day]) => day === today));
    const next = { ...kept, ...Object.fromEntries(ids.map((id) => [id, today])) };
    setSnoozes(next);
    writeStorage(SNOOZE_KEY, next);
  }

  if (closed || !items.length) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="popup-title">
        <header className="modal-head">
          <div>
            <h2 id="popup-title">{items.length === 1 ? "1 item needs attention" : `${items.length} items need attention`}</h2>
            <p className="muted">Shipments arriving and Payments due within {data.thresholdDays} days.</p>
          </div>
          <button className="icon-btn" onClick={() => setClosed(true)} aria-label="Close"><X size={16} /></button>
        </header>
        <ul className="note-list">
          {items.map((item) => (
            <NotificationItem key={item.id} item={item} busy={busyId === item.id} onDone={done} onSnooze={(id) => snooze([id])} onOpen={(row) => { setClosed(true); onOpenRow(row); }} />
          ))}
        </ul>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-foot">
          <small className="muted">“Tomorrow” hides an item until tomorrow. Received items are saved to the register.</small>
          <button className="btn" onClick={() => snooze(items.map((item) => item.id))}>Remind me tomorrow</button>
        </footer>
      </div>
    </div>
  );
}
