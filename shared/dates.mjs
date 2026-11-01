// Date handling shared by the Worker and the import scripts.
// The register is filled in by hand as day/month/year text in several spellings
// ("22/09/2026", "9-11-2026", "28/11/26", "'08/09/2026"), and some cells are real
// Excel dates. Everything is stored and compared as "YYYY-MM-DD".

export const DATE_COLUMNS = ["Date", "VESSEL ETD", "VESSEL ETA", "CHEQUE REFUND DATE"];

const pad = (n) => String(n).padStart(2, "0");

export function ymd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const fullYear = (y) => (y < 100 ? 2000 + y : y);

// Returns { iso, note } or null when the text is not a date (e.g. "N/A", "ya", "DO").
// `note` is set when the text had to be corrected rather than just read.
export function parseDateText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/^'+/, "");
  if (!text) return null;

  // ISO, optionally with a time. The date part is the local date where the event happens,
  // so it is kept as written instead of being shifted to UTC.
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) {
    const iso = ymd(+m[1], +m[2], +m[3]);
    if (iso) return { iso, note: "" };
    const swapped = ymd(+m[1], +m[3], +m[2]); // "2026-13-02" -> 13 Feb
    return swapped ? { iso: swapped, note: `read "${text}" as year-day-month` } : null;
  }

  m = text.match(/^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2}|\d{4})$/);
  if (m) {
    const iso = ymd(fullYear(+m[3]), +m[2], +m[1]);
    return iso ? { iso, note: "" } : null;
  }

  // Missing separator between day and month: "2911/2026" -> 29/11/2026.
  m = text.match(/^(\d{2})(\d{2})[/.\-](\d{2}|\d{4})$/);
  if (m) {
    const iso = ymd(fullYear(+m[3]), +m[2], +m[1]);
    return iso ? { iso, note: `read "${text}" as ${m[1]}/${m[2]}/${m[3]}` } : null;
  }
  return null;
}

export const toIsoDate = (value) => parseDateText(value)?.iso ?? null;

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

// True for values written by the tracking provider ("2027-01-14T23:00:00+01:00").
export const isProviderTimestamp = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
