// Formatting and API helpers shared by every view.

export const ALERT_DAYS = 15;

export const CATEGORIES = [
  { id: "export", label: "Export" },
  { id: "import", label: "Import" },
  { id: "local", label: "Local / internal transfer" }
];

export const CARRIERS = [
  { value: "", label: "Auto-detect carrier" },
  { value: "MSC", label: "MSC" },
  { value: "Hapag-Lloyd", label: "Hapag-Lloyd" },
  { value: "CMA CGM", label: "CMA CGM" },
  { value: "Maersk", label: "Maersk" },
  { value: "MCL", label: "MCL" }
];

// Dates arrive as "YYYY-MM-DD" (or a provider timestamp). They are formatted in UTC so the
// calendar day written in the register is the one shown, whatever the browser's timezone.
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
const AMOUNT_FORMAT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

// Anything that is not a date ("ya", "DO") is shown exactly as written.
export function formatDate(value, { short = false } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const match = ISO_DATE.exec(String(value));
  if (!match) return String(value);
  return (short ? SHORT_DATE_FORMAT : DATE_FORMAT).format(new Date(`${match[1]}T00:00:00Z`));
}

// Provider timestamps keep the local time at the port, as the carrier reported it.
export function formatDateTime(value) {
  const date = formatDate(value);
  const time = /T(\d{2}):(\d{2})/.exec(String(value || ""));
  return time && `${time[1]}:${time[2]}` !== "00:00" ? `${date}, ${time[1]}:${time[2]}` : date;
}

export function formatAmount(value) {
  return value === null || value === undefined ? "" : AMOUNT_FORMAT.format(value);
}

export function relativeDays(days) {
  if (days === null || days === undefined) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

// Calendar days from today (browser local) to a date string.
export function daysFromToday(value) {
  const match = ISO_DATE.exec(String(value || ""));
  if (!match) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(`${match[1]}T00:00:00Z`) - today) / 86400000);
}

export function timeAgo(value) {
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

// Blank means "no amount"; otherwise a non-negative number, commas allowed as separators.
export function parseAmount(text) {
  const cleaned = String(text ?? "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
}

export function matchesQuery(shipment, needle) {
  if (!needle) return true;
  return [shipment.bl, shipment.est, shipment.exitNo, shipment.agent, shipment.consignee, shipment.destination, shipment.containers, shipment.chequeNumber]
    .some((value) => value && String(value).toLowerCase().includes(needle));
}

export async function apiRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
  } catch {
    throw new Error("Could not reach the Kenzol service. Check your connection and try again.");
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

export const updateShipment = (row, fields) =>
  apiRequest("/api/shipments/update", { method: "POST", body: JSON.stringify({ row, fields }) });

export function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
}

export function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
