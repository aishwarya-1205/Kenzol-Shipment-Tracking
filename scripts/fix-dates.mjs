// Repairs the date cells of a live D1 register without re-seeding it.
//
//   npx wrangler d1 execute kenzol --remote --json --command "SELECT rownum, data FROM rows" > d1-rows.json
//   node scripts/fix-dates.mjs backend/data/customs_exit_with_est.xlsx d1-rows.json fix-dates.sql
//   npx wrangler d1 execute kenzol --remote --file=fix-dates.sql
//
// Each UPDATE only applies while the cell still holds the value read from d1-rows.json,
// so rows changed in the app since then (and dates written by the tracking provider) are left alone.
import fs from "node:fs";
import XLSX from "xlsx";
import { DATE_COLUMNS, isProviderTimestamp, parseDateText } from "../shared/dates.mjs";
import { resolveSheetDates } from "./workbook-dates.mjs";

const [, , workbook, rowsJson, output = "fix-dates.sql"] = process.argv;
if (!workbook || !rowsJson) {
  console.error("Usage: node scripts/fix-dates.mjs <workbook.xlsx> <d1-rows.json> [fix-dates.sql]");
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(workbook), { cellDates: false });
const ws = wb.Sheets[wb.SheetNames.includes("Sheet1") ? "Sheet1" : wb.SheetNames[0]];
const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })[0] || [];
const headers = headerRow.flatMap((h, idx) => (typeof h === "string" && h.trim() ? [{ name: h.trim(), idx }] : []));
const fromWorkbook = resolveSheetDates(ws, headers);

const dump = JSON.parse(fs.readFileSync(rowsJson, "utf8").replace(/^﻿/, ""));
const liveRows = (Array.isArray(dump) ? dump : [dump]).flatMap((part) => part.results || []);

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = [];
const report = [];
const problems = [];

for (const { rownum, data: raw } of liveRows) {
  const data = JSON.parse(raw);
  for (const col of DATE_COLUMNS) {
    const current = data[col];
    if (current === undefined || current === null || isProviderTimestamp(current)) continue;
    // Prefer the workbook reading (it can undo Excel's day/month swaps); rows added in
    // the app are only normalised to YYYY-MM-DD.
    const wbEntry = fromWorkbook.get(rownum)?.[col];
    const target = wbEntry?.iso ?? parseDateText(current)?.iso;
    if (wbEntry?.note) problems.push(`row ${rownum} ${col}: ${wbEntry.note}`);
    else if (!target && !/^(N\/?A|NIL|-+)$/i.test(String(current).trim())) problems.push(`row ${rownum} ${col}: not a date: "${current}"`);
    if (!target || target === current) continue;
    const path = `'$."${col}"'`;
    lines.push(
      `UPDATE rows SET data = json_set(data, ${path}, ${sq(target)}) WHERE rownum = ${rownum} AND json_extract(data, ${path}) = ${sq(current)};`
    );
    report.push(`row ${rownum}\t${col}\t${current}\t->\t${target}`);
  }
}
lines.push(`INSERT INTO meta(key, value) VALUES ('modified_at', ${sq(new Date().toISOString())}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);

fs.writeFileSync(output, lines.join("\n") + "\n");
console.log(`Wrote ${output}: ${report.length} date cells to update.\n`);
console.log(report.join("\n"));
if (problems.length) console.log(`\nNeeds a look in the workbook (${problems.length}):\n${problems.join("\n")}`);
