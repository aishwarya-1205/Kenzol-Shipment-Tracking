// Usage: node scripts/import-xlsx.mjs backend/data/customs_exit_with_est.xlsx [seed.sql]
// WARNING: the generated SQL wipes the rows/meta tables first, so it also removes edits
// made in the app (cheque amounts, telex/payment status). Use fix-dates.mjs to repair
// dates in a live database instead.
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { resolveSheetDates } from "./workbook-dates.mjs";

const [, , input, output = "seed.sql"] = process.argv;
if (!input) {
  console.error("Usage: node scripts/import-xlsx.mjs <workbook.xlsx> [seed.sql]");
  process.exit(1);
}

const BL_PLACEHOLDERS = new Set(["", "N/A", "NA", "-", "--", "NIL", "NONE", "TBA", "TBC"]);
const normalizeBl = (v) => (v == null ? "" : String(v).replace(/\s+/g, "").toUpperCase());
function blKey(value) {
  const tokens = new Set([
    normalizeBl(value),
    ...String(value ?? "").split(/[/,;]+/).map(normalizeBl),
  ]);
  const list = [...tokens].filter((t) => !BL_PLACEHOLDERS.has(t));
  return list.length ? `|${list.join("|")}|` : "";
}

function cleanValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

const buf = fs.readFileSync(input);
// cellDates: false keeps Excel date serials as numbers; converting them to JS Dates
// applies the machine's timezone and shifted every date by a day.
const wb = XLSX.read(buf, { cellDates: false });
const sheetName = wb.SheetNames.includes("Sheet1") ? "Sheet1" : wb.SheetNames[0];
const ws = wb.Sheets[sheetName];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });

const headerRow = aoa[0] || [];
const headers = [];
headerRow.forEach((h, idx) => {
  if (typeof h === "string" && h.trim()) headers.push({ name: h.trim(), idx });
});
const blHeader = headers.find((h) => h.name.toLowerCase() === "bl number");
if (!blHeader) {
  console.error("Could not find a 'BL NUMBER' column in the first row.");
  process.exit(1);
}
const dates = resolveSheetDates(ws, headers);

const lines = ["DELETE FROM rows;", "DELETE FROM meta;"];
const meta = {
  headers: JSON.stringify(headers.map((h) => h.name)),
  file_name: path.basename(input),
  sheet_name: sheetName,
  size_bytes: String(buf.length),
  modified_at: new Date().toISOString(),
};
for (const [k, v] of Object.entries(meta)) {
  lines.push(`INSERT INTO meta(key, value) VALUES (${sq(k)}, ${sq(v)});`);
}

let count = 0;
const notes = [];
for (let r = 1; r < aoa.length; r++) {
  const rownum = r + 1;
  const data = {};
  for (const h of headers) {
    const date = dates.get(rownum)?.[h.name];
    const v = date?.iso ?? cleanValue(aoa[r][h.idx]);
    if (v !== null) data[h.name] = v;
    if (date?.note) notes.push(`row ${rownum} ${h.name}: ${date.note}`);
  }
  if (!Object.keys(data).length) continue;
  const key = blKey(data[blHeader.name]);
  lines.push(`INSERT INTO rows(rownum, bl_key, data) VALUES (${rownum}, ${sq(key)}, ${sq(JSON.stringify(data))});`);
  count++;
}

fs.writeFileSync(output, lines.join("\n") + "\n");
console.log(`Wrote ${output}: ${headers.length} columns, ${count} rows from sheet "${sheetName}".`);
if (notes.length) console.log(`\nDate corrections and problems (${notes.length}):\n${notes.join("\n")}`);
