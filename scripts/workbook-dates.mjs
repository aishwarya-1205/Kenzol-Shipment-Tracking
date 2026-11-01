// Reads the date columns of the register sheet and returns the intended date for each cell.
//
// Typed text is read as day/month/year. Real Excel date cells are the risky part: when
// "4/2/26" (4 Feb) is typed into Excel on a month/day machine it is stored as 2 April.
// For those cells both readings are tried and the one that fits is kept:
//   - "Date": rows are entered in date order, so the reading that falls between the
//     nearest unambiguous dates above and below wins.
//   - "VESSEL ETA" / "VESSEL ETD": the vessel moves after the customs exit date on the
//     same row, so the earliest reading on or after that date wins.
import XLSX from "xlsx";
import { DATE_COLUMNS, daysBetween, parseDateText, ymd } from "../shared/dates.mjs";

function serialCandidates(serial) {
  const p = XLSX.SSF.parse_date_code(serial);
  if (!p) return [];
  const asStored = ymd(p.y, p.m, p.d);
  const swapped = p.d <= 12 && p.d !== p.m ? ymd(p.y, p.d, p.m) : null;
  return [asStored, swapped].filter(Boolean);
}

const distanceToRange = (iso, lo, hi) => {
  if (lo && iso < lo) return daysBetween(iso, lo);
  if (hi && iso > hi) return daysBetween(hi, iso);
  return 0;
};

/**
 * @param ws       sheet read with `cellDates: false`
 * @param headers  [{ name, idx }] for the header row
 * @returns Map(rownum -> { [column]: { iso, raw, note } })
 */
export function resolveSheetDates(ws, headers) {
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const cols = headers.filter((h) => DATE_COLUMNS.includes(h.name));
  const out = new Map();
  const cellsByCol = Object.fromEntries(cols.map((h) => [h.name, []]));

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    for (const h of cols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: h.idx })];
      if (!cell || cell.v === null || cell.v === undefined || cell.v === "") continue;
      const rownum = r + 1;
      const entry = { rownum, raw: cell.t === "n" ? cell.w ?? String(cell.v) : String(cell.v), iso: null, note: "", candidates: null };
      if (cell.t === "n") {
        const c = serialCandidates(cell.v);
        if (c.length === 1) entry.iso = c[0];
        else entry.candidates = c;
      } else {
        const parsed = parseDateText(cell.v);
        if (parsed) Object.assign(entry, parsed);
        else if (!/^(N\/?A|NIL|-+)$/i.test(String(cell.v).trim())) entry.note = `not a date: "${String(cell.v).trim()}"`;
      }
      cellsByCol[h.name].push(entry);
      if (!out.has(rownum)) out.set(rownum, {});
      out.get(rownum)[h.name] = entry;
    }
  }

  // "Date": pick the reading closest to the surrounding unambiguous dates.
  const dates = cellsByCol["Date"] || [];
  dates.forEach((entry, i) => {
    if (!entry.candidates) return;
    let lo = null;
    let hi = null;
    for (let j = i - 1; j >= 0 && !lo; j--) if (!dates[j].candidates && dates[j].iso) lo = dates[j].iso;
    for (let j = i + 1; j < dates.length && !hi; j++) if (!dates[j].candidates && dates[j].iso) hi = dates[j].iso;
    const [stored, swapped] = entry.candidates;
    const pick = distanceToRange(swapped, lo, hi) < distanceToRange(stored, lo, hi) ? swapped : stored;
    entry.iso = pick;
    if (pick === swapped) entry.note = `Excel stored ${stored}; day and month were swapped`;
  });

  // Vessel dates: earliest reading on or after the exit date of the same row.
  for (const name of ["VESSEL ETA", "VESSEL ETD"]) {
    for (const entry of cellsByCol[name] || []) {
      const exit = out.get(entry.rownum)?.Date?.iso;
      if (entry.candidates) {
        const [stored, swapped] = entry.candidates;
        const after = exit ? entry.candidates.filter((c) => c >= exit).sort() : [];
        const pick = after[0] ?? stored;
        entry.iso = pick;
        if (pick === swapped) entry.note = `Excel stored ${stored}; day and month were swapped`;
      }
      if (entry.iso && exit && entry.iso < exit) {
        entry.note = [entry.note, `${name} ${entry.iso} is before the exit date ${exit}`].filter(Boolean).join("; ");
      }
    }
  }

  for (const cols of out.values()) for (const e of Object.values(cols)) delete e.candidates;
  return out;
}
