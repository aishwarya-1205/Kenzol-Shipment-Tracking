// Cloudflare Worker port of backend/main.py (FastAPI).
// Excel workbook -> D1 tables `meta` and `rows` (see schema.sql).
import { zipSync, strToU8 } from "fflate";
import { DATE_COLUMNS, daysBetween, toIsoDate } from "../shared/dates.mjs";

export interface Env {
  DB: any; // D1 database
  ASSETS: any; // static frontend assets
  SAFECUBE_API?: string;
  MCL_SCAC?: string;
  APP_TIMEZONE?: string;
}

const PROVIDER_URL = "https://api.sinay.ai/container-tracking/api/v2/shipment";
const SEALINES_URL = "https://api.sinay.ai/container-tracking/api/v2/sealines";

class HttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------------ */
/* Carriers                                                            */
/* ------------------------------------------------------------------ */

function carrierScac(env: Env): Record<string, string> {
  const map: Record<string, string> = {
    MSC: "MSCU",
    "Hapag-Lloyd": "HLCU",
    "CMA CGM": "CMDU",
    Maersk: "MAEU",
  };
  const mcl = (env.MCL_SCAC || "").trim();
  if (mcl) map["MCL"] = mcl.toUpperCase();
  return map;
}

const CARRIER_ALIASES: Record<string, string> = {
  msc: "MSC",
  "hapag-lloyd": "Hapag-Lloyd",
  "hapag lloyd": "Hapag-Lloyd",
  hapaglloyd: "Hapag-Lloyd",
  "cma cgm": "CMA CGM",
  cmacgm: "CMA CGM",
  maersk: "Maersk",
  mcl: "MCL",
};

/* ------------------------------------------------------------------ */
/* Provider response normalisation                                     */
/* ------------------------------------------------------------------ */

const isObj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanText(value: any, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value.trim() || fallback;
  return String(value);
}

function locationName(value: any): string {
  if (typeof value === "string") return value.trim();
  if (!isObj(value)) return "";
  return [cleanText(value.name), cleanText(value.state), cleanText(value.country)]
    .filter(Boolean)
    .join(", ");
}

function routeLocation(route: any, key: string): string {
  if (!isObj(route)) return "";
  const item = route[key];
  if (isObj(item)) return locationName(item.location) || locationName(item);
  return cleanText(item);
}

function parseEvent(event: any, containerNumber = ""): any {
  const loc = locationName(event.location) || locationName(event.facility);
  const vessel = event.vessel;
  const transport = isObj(vessel)
    ? cleanText(vessel.name)
    : cleanText(event.transportType || event.routeType);
  const eventDate = cleanText(event.date || event.eventDateTime || event.eventDate);
  return {
    id: [
      eventDate,
      cleanText(event.eventCode || event.status),
      cleanText(event.description),
      containerNumber,
    ].join("|"),
    title: cleanText(event.description || event.eventCode || event.status, "Shipment event"),
    location: loc,
    date: eventDate,
    time: "",
    transport,
    classifier: cleanText(event.eventCode || event.status),
    isActual: event.isActual ?? null,
    containerNumber,
    eventType: cleanText(event.eventType),
  };
}

function normalizeProviderResponse(data: any, requestedBl: string): any {
  const metadata = data.metadata || {};
  const route = data.route || {};

  const journey: string[] = (Array.isArray(data.locations) ? data.locations : [])
    .map(locationName)
    .filter(Boolean);
  const origin =
    journey[0] ||
    routeLocation(route, "prepol") ||
    routeLocation(route, "prePol") ||
    routeLocation(route, "pol");
  const destination =
    journey[journey.length - 1] ||
    routeLocation(route, "postpod") ||
    routeLocation(route, "postPod") ||
    routeLocation(route, "pod");

  const containers: any[] = [];
  const allEvents: any[] = [];
  for (const container of Array.isArray(data.containers) ? data.containers : []) {
    if (!isObj(container)) continue;
    const number = cleanText(container.number || container.containerNumber);
    containers.push({
      containerNumber: number,
      isoCode: cleanText(container.isoCode),
      sizeType: cleanText(container.sizeType),
      status: cleanText(container.status),
    });
    for (const ev of Array.isArray(container.events) ? container.events : []) {
      if (isObj(ev)) allEvents.push(parseEvent(ev, number));
    }
  }
  for (const ev of Array.isArray(data.events) ? data.events : []) {
    if (isObj(ev)) allEvents.push(parseEvent(ev));
  }

  const seen = new Set<string>();
  const events: any[] = [];
  for (const ev of allEvents) {
    const fp = [ev.id, ev.title, ev.location, ev.date, ev.containerNumber].join("\u0000");
    if (!seen.has(fp)) {
      seen.add(fp);
      events.push(ev);
    }
  }
  // Dates carry different UTC offsets, so compare instants rather than strings.
  const when = (ev: any) => {
    const t = Date.parse(cleanText(ev.date));
    return Number.isNaN(t) ? Infinity : t;
  };
  events.sort((a, b) => when(a) - when(b));

  const statusCode = cleanText(metadata.shippingStatus, "UNKNOWN");
  const statusLabels: Record<string, string> = {
    PLANNED: "Planned",
    IN_TRANSIT: "In transit",
    DELIVERED: "Delivered",
    UNKNOWN: "Status unavailable",
  };
  const status =
    statusLabels[statusCode.toUpperCase()] ??
    statusCode.replace(/_/g, " ").replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

  // route.pod.date is an estimate until the carrier reports it as actual.
  let eta = "";
  let etaActual = false;
  const pod = isObj(route) ? route.pod : null;
  if (isObj(pod)) {
    eta = cleanText(pod.eta || pod.estimatedArrival || pod.estimatedDate || pod.date);
    etaActual = pod.actual === true;
  }

  return {
    shipmentNumber: cleanText(metadata.shipmentNumber, requestedBl),
    carrier: cleanText(metadata.sealineName || metadata.sealine, "Carrier not identified"),
    status,
    statusCode,
    origin: origin || "Not provided by carrier",
    destination: destination || "Not provided by carrier",
    eta,
    etaActual,
    lastUpdated: cleanText(metadata.updatedAt),
    containers,
    events,
    warnings: metadata.warnings || [],
    shipmentType: cleanText(metadata.shipmentType, "BL"),
    sealine: cleanText(metadata.sealine),
    locations: data.locations || [],
    vessels: data.vessels || [],
    coordinates: data.coordinates ?? null,
    routeData: data.routeData ?? null,
    providerRoute: route,
  };
}

/* ------------------------------------------------------------------ */
/* Tracking                                                            */
/* ------------------------------------------------------------------ */

function getApiKey(env: Env): string {
  const key = (env.SAFECUBE_API || "").trim();
  if (!key) {
    throw new HttpError(
      500,
      "SAFECUBE_API is missing. Set it with: npx wrangler secret put SAFECUBE_API"
    );
  }
  return key;
}

async function trackShipment(env: Env, blNumber: string, carrier: string | null): Promise<any> {
  const apiKey = getApiKey(env);
  const shipmentNumber = blNumber.replace(/\s+/g, "");
  if (!shipmentNumber) throw new HttpError(422, "Enter a Bill of Lading number.");

  const params = new URLSearchParams({
    shipmentNumber,
    shipmentType: "BL",
    route: "true",
    ais: "false",
  });

  let selectedCarrier: string | null = null;
  if (carrier && carrier.trim()) {
    selectedCarrier = CARRIER_ALIASES[carrier.trim().toLowerCase()] ?? null;
    if (!selectedCarrier) {
      throw new HttpError(
        400,
        `Unsupported carrier selection: ${carrier}. Choose a carrier from the dropdown or use Auto-detect.`
      );
    }
    const scac = carrierScac(env)[selectedCarrier];
    if (!scac) {
      throw new HttpError(
        400,
        `A verified SafeCube sealine code is not configured for ${selectedCarrier}. Use Auto-detect or set the MCL_SCAC secret.`
      );
    }
    params.set("sealine", scac);
  }

  let response: Response;
  try {
    response = await fetch(`${PROVIDER_URL}?${params}`, {
      headers: { API_KEY: apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(45000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new HttpError(504, "The tracking provider took too long to respond. Please try again shortly.");
    }
    throw new HttpError(502, "Could not connect to the tracking provider. Please try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, "The tracking provider rejected the API key. Check the SAFECUBE_API secret and your API plan.");
  }
  if (response.status === 429) {
    throw new HttpError(429, "The tracking provider rate limit was reached. Wait a little before trying again.");
  }
  if (response.status === 404) {
    throw new HttpError(404, "The tracking endpoint or shipment was not found. Verify the BL number and provider API access.");
  }
  if (response.status >= 500) {
    throw new HttpError(502, `The tracking provider returned an error (HTTP ${response.status}). Please try again later.`);
  }
  if (!response.ok) {
    throw new HttpError(
      400,
      `The tracking provider rejected the request (HTTP ${response.status}). Verify the BL number, shipment type and carrier.`
    );
  }

  let providerData: any;
  try {
    providerData = await response.json();
  } catch {
    throw new HttpError(502, "The tracking provider returned an unreadable response.");
  }
  if (!isObj(providerData)) {
    throw new HttpError(502, "The tracking provider returned an unexpected response format.");
  }

  const metadata = providerData.metadata || {};
  const providerMessage = cleanText(providerData.message || providerData.error);
  if (providerData.status === "error" || (providerData.errorCode !== undefined && providerData.errorCode !== null)) {
    throw new HttpError(
      404,
      providerMessage || "The provider could not retrieve this shipment. Check the BL number and carrier."
    );
  }
  const hasMeta = isObj(metadata) && Object.keys(metadata).length > 0;
  const hasData =
    (Array.isArray(providerData.containers) && providerData.containers.length > 0) ||
    (Array.isArray(providerData.events) && providerData.events.length > 0);
  if (!hasMeta && !hasData) {
    throw new HttpError(
      404,
      providerMessage || "No shipment details were returned. Check the BL number or try Auto-detect for the carrier."
    );
  }

  const normalized = normalizeProviderResponse(providerData, shipmentNumber);
  if (selectedCarrier) normalized.selectedCarrier = selectedCarrier;
  return normalized;
}

async function getSealines(env: Env): Promise<any> {
  const apiKey = getApiKey(env);
  let response: Response;
  try {
    response = await fetch(SEALINES_URL, {
      headers: { API_KEY: apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new HttpError(502, "Could not connect to the tracking provider.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, "The provider rejected the API key.");
  }
  if (!response.ok) throw new HttpError(502, `The provider returned HTTP ${response.status}.`);
  try {
    return { sealines: await response.json() };
  } catch {
    throw new HttpError(502, "The provider returned an unreadable sealine list.");
  }
}

/* ------------------------------------------------------------------ */
/* Register helpers (D1 instead of the Excel file)                     */
/* ------------------------------------------------------------------ */

const BL_PLACEHOLDERS = new Set(["", "N/A", "NA", "-", "--", "NIL", "NONE", "TBA", "TBC"]);
const REGISTER_COLUMNS = [
  "BL NUMBER",
  "Shipping Line",
  "Container No",
  "NO. OF CONTAINERS",
  "point of loading",
  "Destination",
  "VESSEL ETD",
  "VESSEL ETA",
  "CONSIGNEE NAME",
  "Date",
];
const ALERT_DAYS = 15;
const RECEIVED = "Received";

// Fields the dashboard may change. "bl" fields describe the whole Bill of Lading, so
// they are written to every row that shares a BL with the edited row; "row" fields
// belong to one customs exit / cheque.
const EDITABLE: Record<string, { header: string; scope: "row" | "bl"; values?: string[]; kind?: "amount" | "date" }> = {
  chequeAmount: { header: "CHEQUE AMOUNT", scope: "row", kind: "amount" },
  refundDate: { header: "CHEQUE REFUND DATE", scope: "row", kind: "date" },
  refundStatus: { header: "REFUND STATUS", scope: "row", values: [RECEIVED] },
  telexStatus: { header: "TELEX STATUS", scope: "bl", values: ["Pending", "Released"] },
  paymentStatus: { header: "PAYMENT STATUS", scope: "bl", values: [RECEIVED] },
};

const PLACEHOLDER = /^(N\/?A|NIL|NONE|-+|TBA|TBC)$/i;

// The TYPE column drives the Export / Import / Local categories. It was only filled in
// from September, so older rows are classified from the destination and flagged as inferred.
const UAE_PLACE = /\b(SHARJAH|SHJ|HAMRIYAH|SAIF ZONE|RAS AL KHAIMAH|RAK|DUBAI|DXB|AJMAN|JEBEL ALI|JAFZA|FUJAIRAH|UMM AL QUWAIN|ABU DHABI|INTERNAL TRANSFER|UAE)\b/i;

function categoryOf(type: string, destination: string): { category: string; inferred: boolean } {
  const t = type.toUpperCase();
  if (/IMPORT/.test(t)) return { category: "import", inferred: false };
  if (/EXPORT|TRANSIT/.test(t)) return { category: "export", inferred: false };
  if (/LOCAL|INTERNAL/.test(t)) return { category: "local", inferred: false };
  if (!destination) return { category: "unclassified", inferred: false };
  return { category: UAE_PLACE.test(destination) ? "local" : "export", inferred: true };
}

function normalizeBl(value: any): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, "").toUpperCase();
}

function blTokens(value: any): Set<string> {
  const tokens = new Set<string>([normalizeBl(value)]);
  for (const part of String(value ?? "").split(/[/,;]+/)) tokens.add(normalizeBl(part));
  return new Set([...tokens].filter((t) => !BL_PLACEHOLDERS.has(t)));
}

function blKeyOf(value: any): string {
  const t = [...blTokens(value)];
  return t.length ? `|${t.join("|")}|` : "";
}

const keyTokens = (blKey: string) => new Set(blKey.split("|").filter(Boolean));

function firstPresent(...values: any[]): any {
  for (const v of values) if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  return null;
}

function routeField(route: any, ...keys: string[]): any {
  if (!isObj(route)) return null;
  for (const key of keys) {
    const value = route[key];
    if (isObj(value)) {
      const c = firstPresent(value.etd, value.eta, value.estimatedDate, value.date);
      if (c !== null) return c;
    } else if (value !== null && value !== undefined && String(value).trim()) {
      return value;
    }
  }
  return null;
}

type RowRec = { rownum: number; blKey: string; data: string };

async function loadMeta(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta").all();
  const out: Record<string, string> = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

async function loadHeaders(env: Env): Promise<{ headers: string[]; meta: Record<string, string> }> {
  const meta = await loadMeta(env);
  let headers: string[] = [];
  try {
    headers = JSON.parse(meta.headers || "[]");
  } catch {
    headers = [];
  }
  if (!headers.length) {
    throw new HttpError(404, "The shipment register is empty. Import the workbook into D1 first (see README steps).");
  }
  return { headers, meta };
}

const headerMapOf = (headers: string[]) => new Map(headers.map((h) => [h.trim().toLowerCase(), h]));

async function loadRows(env: Env): Promise<RowRec[]> {
  const { results } = await env.DB.prepare(
    "SELECT rownum, bl_key AS blKey, data FROM rows ORDER BY rownum"
  ).all();
  return results || [];
}

function metaSet(env: Env, key: string, value: string) {
  return env.DB.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value);
}

function saveRowStmt(env: Env, rownum: number, data: any, blHeader: string | undefined) {
  const key = blHeader ? blKeyOf(data[blHeader]) : "";
  return env.DB.prepare("UPDATE rows SET data = ?, bl_key = ? WHERE rownum = ?").bind(
    JSON.stringify(data),
    key,
    rownum
  );
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, "Request body must be valid JSON.");
  }
}

function queryParam(url: URL, name: string, min: number, max: number): string {
  const v = url.searchParams.get(name);
  if (v === null || v.length < min) throw new HttpError(422, `Query parameter '${name}' is required (min ${min} characters).`);
  if (v.length > max) throw new HttpError(422, `Query parameter '${name}' is too long (max ${max} characters).`);
  return v;
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

// "YYYY-MM-DD" in the office timezone.
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const isDateColumn = (name: string) => DATE_COLUMNS.some((c) => c.toLowerCase() === name.toLowerCase());

// Date cells as "YYYY-MM-DD" when they can be read; anything else is returned as written.
const displayDate = (value: any) => (value === null || value === undefined ? null : toIsoDate(value) ?? value);

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

async function updateExcel(env: Env, blNumber: string, carrier: string | null) {
  const shipment = await trackShipment(env, blNumber, carrier);
  const providerRoute = shipment.providerRoute || {};
  const containerNumbers: string[] = (shipment.containers || [])
    .map((c: any) => cleanText(c?.containerNumber))
    .filter(Boolean);
  const eta = firstPresent(shipment.eta, routeField(providerRoute, "pod", "postpod", "postPod"));
  const etd = routeField(providerRoute, "pol", "prepol", "prePol");

  const { headers } = await loadHeaders(env);
  const hm = headerMapOf(headers);
  const blHeader = hm.get("bl number");
  if (!blHeader) throw new HttpError(400, "Could not find a 'BL NUMBER' column in the register.");

  // Token match, so a row holding "A/B" is updated when either BL is synced.
  const target = blTokens(blNumber);
  const rows = await loadRows(env);
  const matching = rows
    .filter((r) => [...keyTokens(r.blKey)].some((t) => target.has(t)))
    .map((r) => ({ rownum: r.rownum, data: JSON.parse(r.data) }));

  const candidate: Record<string, any> = {
    "Shipping Line": shipment.carrier,
    "Container No": containerNumbers.length ? containerNumbers.join(", ") : null,
    "NO. OF CONTAINERS": containerNumbers.length || null,
    "point of loading": shipment.origin,
    Destination: shipment.destination,
    "VESSEL ETD": etd,
    "VESSEL ETA": eta,
    "BL NUMBER": shipment.shipmentNumber || blNumber,
  };
  const unavailable = new Set(["", "—", "Not provided by carrier", "Carrier not identified", "Status unavailable"]);
  const updates: Record<string, any> = {}; // actual header -> value
  const fieldsUpdated: string[] = [];
  for (const [name, value] of Object.entries(candidate)) {
    const actual = hm.get(name.toLowerCase());
    if (!actual || value === null || value === undefined) continue;
    if (unavailable.has(String(value).trim())) continue;
    updates[actual] = value;
    fieldsUpdated.push(name);
  }
  if (!fieldsUpdated.length) {
    throw new HttpError(502, "The provider returned no usable fields to write to the register.");
  }

  const stmts: any[] = [];
  const rowsUpdated: number[] = [];
  const createdNewRow = matching.length === 0;
  if (createdNewRow) {
    const next = Math.max(2, ...rows.map((r) => r.rownum + 1));
    stmts.push(
      env.DB.prepare("INSERT INTO rows(rownum, bl_key, data) VALUES (?, ?, ?)").bind(
        next,
        blKeyOf(updates[blHeader]),
        JSON.stringify(updates)
      )
    );
    rowsUpdated.push(next);
  } else {
    // Existing rows keep the BL as typed (it may list several BLs).
    delete updates[blHeader];
    for (const r of matching) {
      Object.assign(r.data, updates);
      stmts.push(saveRowStmt(env, r.rownum, r.data, blHeader));
      rowsUpdated.push(r.rownum);
    }
  }
  stmts.push(metaSet(env, "modified_at", new Date().toISOString()));
  await env.DB.batch(stmts);

  return {
    success: true,
    message: createdNewRow
      ? `Added BL ${blNumber} as a new row in the register.`
      : `Updated existing register row(s) for BL ${blNumber}.`,
    action: createdNewRow ? "created" : "overwritten",
    fileName: (await loadMeta(env)).file_name || "register",
    rowsUpdated,
    fieldsUpdated,
    shipmentNumber: shipment.shipmentNumber,
  };
}

async function excelSummary(env: Env, all = false) {
  const { headers, meta } = await loadHeaders(env);
  const hm = headerMapOf(headers);
  const columns = all ? headers : REGISTER_COLUMNS.filter((c) => hm.has(c.toLowerCase()));
  const rows: any[] = [];
  for (const r of await loadRows(env)) {
    const data = JSON.parse(r.data);
    const values: Record<string, any> = {};
    for (const name of columns) {
      const value = data[hm.get(name.toLowerCase())!] ?? null;
      values[name] = isDateColumn(name) ? displayDate(value) : value;
    }
    const bl = normalizeBl(values["BL NUMBER"]);
    rows.push({ row: r.rownum, hasBL: !BL_PLACEHOLDERS.has(bl), values });
  }
  return {
    fileName: meta.file_name || "register.xlsx",
    sheetName: meta.sheet_name || "Sheet1",
    sizeBytes: Number(meta.size_bytes || 0),
    modifiedAt: meta.modified_at || null,
    columns,
    totalRecords: rows.length,
    trackedRecords: rows.filter((r) => r.hasBL).length,
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard: one record per register row                              */
/* ------------------------------------------------------------------ */

type Shipment = Record<string, any>;

async function loadShipments(env: Env): Promise<{ shipments: Shipment[]; meta: Record<string, string>; today: string }> {
  const { headers, meta } = await loadHeaders(env);
  const hm = headerMapOf(headers);
  const today = todayInTz(env.APP_TIMEZONE || "UTC");
  const text = (data: any, name: string) => {
    const header = hm.get(name.toLowerCase());
    const v = header ? cleanText(data[header]) : "";
    return PLACEHOLDER.test(v) ? "" : v;
  };
  const dateOf = (data: any, name: string) => {
    const raw = text(data, name);
    const iso = raw ? toIsoDate(raw) : null;
    return { value: iso ?? (raw || null), days: iso ? daysBetween(today, iso) : null };
  };
  const amount = (data: any) => {
    const v = data[hm.get("cheque amount") ?? EDITABLE.chequeAmount.header];
    return typeof v === "number" ? v : null;
  };

  const shipments = (await loadRows(env)).map((r) => {
    const data = JSON.parse(r.data);
    const field = (name: string) => cleanText(data[EDITABLE[name].header]);
    const type = text(data, "TYPE");
    const destination = text(data, "Destination");
    const eta = dateOf(data, "VESSEL ETA");
    const refund = dateOf(data, EDITABLE.refundDate.header);
    return {
      row: r.rownum,
      blKey: r.blKey,
      bl: r.blKey ? text(data, "BL NUMBER") : "",
      est: text(data, "EST NUMBER"),
      date: dateOf(data, "Date").value,
      exitNo: text(data, "Exit No"),
      type,
      ...categoryOf(type, destination),
      chequeNumber: text(data, "CHEQUE NUMBER"),
      chequeAmount: amount(data),
      refundDate: refund.value,
      refundDays: refund.days,
      refundStatus: field("refundStatus"),
      agent: text(data, "Agent Name").replace(/\s+/g, " "),
      consignee: text(data, "CONSIGNEE NAME"),
      containers: text(data, "Container No"),
      containerCount: text(data, "NO. OF CONTAINERS"),
      origin: text(data, "point of loading"),
      destination,
      shippingLine: text(data, "Shipping Line"),
      etd: dateOf(data, "VESSEL ETD").value,
      eta: eta.value,
      etaDays: eta.days,
      telexStatus: field("telexStatus"),
      paymentStatus: field("paymentStatus"),
    };
  });
  return { shipments, meta, today };
}

async function listShipments(env: Env) {
  const { shipments, meta, today } = await loadShipments(env);
  return { today, modifiedAt: meta.modified_at || null, alertDays: ALERT_DAYS, shipments };
}

async function updateShipment(env: Env, body: any) {
  const rownum = body?.row;
  const fields = body?.fields;
  if (!Number.isInteger(rownum) || !isObj(fields) || !Object.keys(fields).length) {
    throw new HttpError(422, "Send a 'row' number and the 'fields' to change.");
  }

  const changes: Record<string, any> = {}; // header -> value (null clears)
  const scopes = new Set<string>();
  for (const [name, value] of Object.entries(fields)) {
    const spec = EDITABLE[name];
    if (!spec) throw new HttpError(422, `'${name}' cannot be edited.`);
    let v: any = value === "" || value === undefined ? null : value;
    if (v !== null) {
      if (spec.kind === "amount") {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new HttpError(422, "Cheque amount must be a positive number.");
      } else if (spec.kind === "date") {
        v = toIsoDate(v);
        if (!v) throw new HttpError(422, "Refund date must be a valid date.");
      } else if (!spec.values!.includes(v)) {
        throw new HttpError(422, `'${name}' must be one of: ${spec.values!.join(", ")}.`);
      }
    }
    changes[spec.header] = v;
    scopes.add(spec.scope);
  }

  const { headers } = await loadHeaders(env);
  const hm = headerMapOf(headers);
  const blHeader = hm.get("bl number");
  const rows = await loadRows(env);
  const edited = rows.find((r) => r.rownum === rownum);
  if (!edited) throw new HttpError(404, `Row ${rownum} is no longer in the register.`);

  const stmts: any[] = [];
  const newHeaders = Object.keys(changes).filter((h) => !hm.has(h.toLowerCase()));
  if (newHeaders.length) stmts.push(metaSet(env, "headers", JSON.stringify([...headers, ...newHeaders])));

  const tokens = keyTokens(edited.blKey);
  const sameBl = (r: RowRec) => r.rownum === rownum || (tokens.size > 0 && [...keyTokens(r.blKey)].some((t) => tokens.has(t)));
  const rowsUpdated: number[] = [];
  for (const r of rows) {
    const inRow = r.rownum === rownum;
    const inBl = scopes.has("bl") && sameBl(r);
    if (!inRow && !inBl) continue;
    const data = JSON.parse(r.data);
    for (const [name, value] of Object.entries(fields)) {
      const spec = EDITABLE[name];
      if (spec.scope === "row" && !inRow) continue;
      const header = hm.get(spec.header.toLowerCase()) ?? spec.header;
      const v = changes[spec.header];
      if (v === null) delete data[header];
      else data[header] = v;
    }
    stmts.push(saveRowStmt(env, r.rownum, data, blHeader));
    rowsUpdated.push(r.rownum);
  }
  stmts.push(metaSet(env, "modified_at", new Date().toISOString()));
  await env.DB.batch(stmts);
  return { success: true, rowsUpdated };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

// Arrival: request payment once a BL's vessel ETA is within ALERT_DAYS (until marked received).
// Refund: chase the cheque refund once its due date is within ALERT_DAYS (until marked received).
async function notifications(env: Env) {
  const { shipments, today } = await loadShipments(env);

  const arrivals = new Map<string, any>();
  const paid = new Set<string>();
  for (const s of shipments) {
    if (s.etaDays === null) continue;
    const key = s.blKey || `row:${s.row}`;
    if (s.paymentStatus === RECEIVED) paid.add(key);
    if (s.etaDays > ALERT_DAYS) continue;
    const prev = arrivals.get(key);
    if (!prev || s.etaDays < prev.days) {
      arrivals.set(key, {
        id: `arrival:${key}`,
        kind: "arrival",
        row: s.row,
        bl: s.bl,
        exitNo: s.exitNo,
        consignee: s.consignee,
        agent: s.agent,
        destination: s.destination,
        date: s.eta,
        days: s.etaDays,
      });
    }
  }

  const refunds = shipments
    .filter((s) => s.refundDays !== null && s.refundDays <= ALERT_DAYS && s.refundStatus !== RECEIVED)
    .map((s) => ({
      id: `refund:${s.row}`,
      kind: "refund",
      row: s.row,
      bl: s.bl,
      exitNo: s.exitNo,
      chequeNumber: s.chequeNumber,
      chequeAmount: s.chequeAmount,
      consignee: s.consignee,
      agent: s.agent,
      date: s.refundDate,
      days: s.refundDays,
    }));

  const items = [...[...arrivals.entries()].filter(([key]) => !paid.has(key)).map(([, a]) => a), ...refunds].sort(
    (a, b) => a.days - b.days
  );
  return { today, thresholdDays: ALERT_DAYS, items };
}

async function deleteRegisterRows(env: Env, body: any) {
  const existing: number[] = ((await env.DB.prepare("SELECT rownum FROM rows").all()).results || []).map((r: any) => r.rownum);
  let targets: number[] = [];

  if (Array.isArray(body?.rows)) {
    const wanted = body.rows;
    if (!wanted.length || wanted.length > 500 || !wanted.every((n: any) => Number.isInteger(n))) {
      throw new HttpError(422, "'rows' must be a list of 1 to 500 row numbers.");
    }
    const have = new Set(existing);
    targets = [...new Set<number>(wanted)].filter((n) => have.has(n));
  } else if (typeof body?.bl === "string" && body.bl.trim() && body.bl.length <= 200) {
    const wanted = blTokens(body.bl);
    const rows = await loadRows(env);
    targets = rows.filter((r) => [...keyTokens(r.blKey)].some((t) => wanted.has(t))).map((r) => r.rownum);
  } else {
    throw new HttpError(422, "Send either 'rows' or 'bl'.");
  }

  if (!targets.length) throw new HttpError(404, "Nothing to delete: the row or BL is no longer in the register.");

  await env.DB.batch([
    ...targets.map((n) => env.DB.prepare("DELETE FROM rows WHERE rownum = ?").bind(n)),
    metaSet(env, "modified_at", new Date().toISOString()),
  ]);
  return { success: true, deleted: targets.length, rowsDeleted: targets };
}

/* ------------------------------------------------------------------ */
/* Download (.xlsx built on the fly; ?format=csv also available)       */
/* ------------------------------------------------------------------ */

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const xmlEsc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));

// Excel serial for a "YYYY-MM-DD" date (days since 1899-12-30).
const excelSerial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

// Date columns are written as real date cells shown as dd/mm/yyyy, so opening the file
// in Excel never re-reads a day/month text as month/day.
function buildXlsx(headers: string[], rows: any[][]): Uint8Array {
  const dateCols = new Set(headers.flatMap((h, i) => (isDateColumn(h) ? [i] : [])));
  const cell = (r: number, c: number, v: any, style = 0): string => {
    if (v === null || v === undefined || v === "") return "";
    const ref = `${colName(c)}${r}`;
    const iso = r > 1 && dateCols.has(c) ? toIsoDate(v) : null;
    if (iso) return `<c r="${ref}" s="2"><v>${excelSerial(iso)}</v></c>`;
    const s = style ? ` s="${style}"` : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
  };
  const sheetRows = [`<row r="1">${headers.map((h, i) => cell(1, i, h, 1)).join("")}</row>`];
  rows.forEach((vals, i) => {
    const r = i + 2;
    sheetRows.push(`<row r="${r}">${vals.map((v, c) => cell(r, c, v)).join("")}</row>`);
  });

  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    "xl/styles.xml": strToU8(
      `${X}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `${X}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join("")}</sheetData></worksheet>`
    ),
  };
  return zipSync(files, { level: 1 });
}

const csvEsc = (v: any) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function downloadExcel(env: Env, format: string): Promise<Response> {
  const { headers, meta } = await loadHeaders(env);
  const rows = (await loadRows(env)).map((r) => {
    const data = JSON.parse(r.data);
    return headers.map((h) => data[h] ?? null);
  });
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: env.APP_TIMEZONE || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date())
    .replace(" ", "_")
    .replace(":", "");
  const stem = (meta.file_name || "register.xlsx").replace(/\.xlsx$/i, "");

  if (format === "csv") {
    const dmy = (v: any, i: number) => {
      const iso = isDateColumn(headers[i]) ? toIsoDate(v) : null;
      return iso ? iso.split("-").reverse().join("/") : v;
    };
    const csv = "\ufeff" + [headers, ...rows.map((r) => r.map(dmy))].map((r) => r.map(csvEsc).join(",")).join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${stem}_${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return new Response(buildXlsx(headers, rows) as any, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${stem}_${stamp}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  if (method === "GET") {
    switch (pathname) {
      case "/api/health":
        return json({
          status: "ok",
          apiKeyConfigured: Boolean((env.SAFECUBE_API || "").trim()),
          provider: "SafeCube/Sinay Container Tracking API",
        });
      case "/api/carriers":
        return json({
          carriers: Object.entries(carrierScac(env)).map(([name, sealine]) => ({ name, sealine, configured: true })),
          autoDetectAvailable: true,
          note: "MCL appears only after the MCL_SCAC secret is set with a verified provider sealine code.",
        });
      case "/api/track":
        return json(
          await trackShipment(env, queryParam(url, "bl_number", 5, 80), url.searchParams.get("carrier"))
        );
      case "/api/sealines":
        return json(await getSealines(env));
      case "/api/excel":
        return json(await excelSummary(env, url.searchParams.get("view") === "all"));
      case "/api/excel/download":
        return downloadExcel(env, (url.searchParams.get("format") || "xlsx").toLowerCase());
      case "/api/shipments":
        return json(await listShipments(env));
      case "/api/notifications":
        return json(await notifications(env));
    }
  } else if (method === "POST") {
    switch (pathname) {
      case "/api/update-excel":
        return json(
          await updateExcel(env, queryParam(url, "bl_number", 5, 80), url.searchParams.get("carrier"))
        );
      case "/api/shipments/update":
        return json(await updateShipment(env, await readJson(request)));
      case "/api/register/delete":
        return json(await deleteRegisterRows(env, await readJson(request)));
    }
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env, new URL(request.url));
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.detail }, err.status);
      console.error("Unhandled error", err);
      return json({ detail: "Unexpected server error." }, 500);
    }
  },
};