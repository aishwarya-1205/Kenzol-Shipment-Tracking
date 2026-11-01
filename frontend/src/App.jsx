import { useCallback, useEffect, useRef, useState } from "react";
import { Database, List, MagnifyingGlass, SidebarSimple, SquaresFour, UsersThree } from "@phosphor-icons/react";
import { ShipmentDrawer } from "./components.jsx";
import { NotificationBell, NotificationPopup } from "./Notifications.jsx";
import { CATEGORIES, apiRequest, readStorage, writeStorage } from "./lib.js";
import { AgentsView } from "./views/Agents.jsx";
import { Dashboard } from "./views/Dashboard.jsx";
import { RegisterView } from "./views/Register.jsx";
import { TrackView } from "./views/Track.jsx";

const RECENT_KEY = "kenzol-recent";
const SIDEBAR_KEY = "kenzol-sidebar-collapsed";
const NOTIFICATION_CHECK_MS = 60 * 60 * 1000;

const VIEWS = ["dashboard", "track", "agents", "register"];

// Routes live in the hash: #dashboard, #track, #track/export, #agents, #register.
function parseRoute(hash = window.location.hash) {
  const [view, sub = ""] = hash.replace(/^#/, "").split("/");
  if (!VIEWS.includes(view)) return { view: "dashboard", sub: "" };
  return { view, sub: view === "track" && CATEGORIES.some((c) => c.id === sub) ? sub : "" };
}

function Sidebar({ route, onNavigate, collapsed: collapsedSetting, onToggle, mobileOpen, onCloseMobile }) {
  // The mobile menu always opens full width.
  const collapsed = collapsedSetting && !mobileOpen;
  const items = [
    { view: "dashboard", label: "Dashboard", icon: SquaresFour },
    { view: "track", label: "Track shipment", icon: MagnifyingGlass, children: CATEGORIES },
    { view: "agents", label: "Shipping agents", icon: UsersThree },
    { view: "register", label: "Register", icon: Database }
  ];
  return (
    <>
      {mobileOpen && <div className="scrim" onClick={onCloseMobile} />}
      <aside className={`sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-open" : ""}`}>
        <div className="brand">
          {collapsed ? <img src="/kenzol-mark.svg" alt="Kenzol" className="brand-mark" /> : <img src="/kenzol-logo.png" alt="Kenzol" className="brand-logo" />}
        </div>
        <nav className="nav" aria-label="Main">
          {items.map(({ view, label, icon: Icon, children }) => {
            const active = route.view === view;
            return (
              <div key={view}>
                <button
                  className={`nav-item ${active && !route.sub ? "active" : ""} ${active ? "in-section" : ""}`}
                  onClick={() => onNavigate(view)}
                  aria-current={active && !route.sub ? "page" : undefined}
                  title={collapsed ? label : undefined}
                >
                  <Icon size={18} weight={active ? "fill" : "regular"} />
                  <span className="nav-text">{label}</span>
                </button>
                {children && !collapsed && (
                  <div className="nav-sub">
                    {children.map((child) => (
                      <button
                        key={child.id}
                        className={`nav-subitem ${active && route.sub === child.id ? "active" : ""}`}
                        onClick={() => onNavigate(view, child.id)}
                        aria-current={active && route.sub === child.id ? "page" : undefined}
                      >
                        {child.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <button className="nav-item collapse-btn" onClick={onToggle} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <SidebarSimple size={18} />
          <span className="nav-text">Collapse</span>
        </button>
      </aside>
    </>
  );
}

export default function App() {
  const [route, setRoute] = useState(() => parseRoute());
  const [collapsed, setCollapsed] = useState(() => readStorage(SIDEBAR_KEY, false));
  const [mobileNav, setMobileNav] = useState(false);
  const [health, setHealth] = useState(null);

  const [shipments, setShipments] = useState({ data: null, error: "" });
  const [notifications, setNotifications] = useState(null);
  const [drawerRow, setDrawerRow] = useState(null);

  const [excel, setExcel] = useState({ data: null, loading: false, error: "" });
  const [excelAll, setExcelAll] = useState(false);
  const excelRequest = useRef(0);

  const [blNumber, setBlNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracked, setTracked] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState("");
  const [lastSearched, setLastSearched] = useState("");
  const [savingExcel, setSavingExcel] = useState(false);
  const [notice, setNotice] = useState(null);
  const [highlightRows, setHighlightRows] = useState([]);
  const [recent, setRecent] = useState(() => readStorage(RECENT_KEY, []));

  useEffect(() => writeStorage(RECENT_KEY, recent.slice(0, 5)), [recent]);
  useEffect(() => writeStorage(SIDEBAR_KEY, collapsed), [collapsed]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => (r.ok ? r.json() : false)).then(setHealth).catch(() => setHealth(false));
  }, []);

  const loadShipments = useCallback(async () => {
    try {
      setShipments({ data: await apiRequest("/api/shipments"), error: "" });
    } catch (err) {
      setShipments((prev) => ({ ...prev, error: err.message }));
    }
  }, []);

  // Notifications are a reminder only; a failed check is retried on the next interval.
  const loadNotifications = useCallback(async () => {
    try { setNotifications(await apiRequest("/api/notifications")); } catch { /* retried later */ }
  }, []);

  const loadExcel = useCallback(async () => {
    const id = ++excelRequest.current; // ignore stale responses when the column set is switched quickly
    setExcel((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const data = await apiRequest(excelAll ? "/api/excel?view=all" : "/api/excel");
      if (id === excelRequest.current) setExcel({ data, loading: false, error: "" });
    } catch (err) {
      if (id === excelRequest.current) setExcel((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, [excelAll]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadShipments(), loadNotifications(), route.view === "register" ? loadExcel() : null]);
  }, [loadShipments, loadNotifications, loadExcel, route.view]);

  useEffect(() => {
    loadShipments();
    loadNotifications();
    const id = setInterval(loadNotifications, NOTIFICATION_CHECK_MS);
    return () => clearInterval(id);
  }, [loadShipments, loadNotifications]);

  useEffect(() => { if (route.view === "register") loadExcel(); }, [route.view, loadExcel]);

  function navigate(view, sub = "") {
    window.location.hash = sub ? `${view}/${sub}` : view;
    setRoute({ view, sub });
    setNotice(null);
    setMobileNav(false);
    window.scrollTo({ top: 0 });
  }

  async function trackShipment(value = blNumber, carrierValue = carrier) {
    const cleaned = value.trim().replace(/\s+/g, "");
    if (cleaned.length < 5) {
      setTrackError("Enter a valid Bill of Lading number (at least 5 characters).");
      return;
    }
    setBlNumber(cleaned);
    setTrackLoading(true);
    setTrackError("");
    setNotice(null);
    setLastSearched(cleaned);
    try {
      const params = new URLSearchParams({ bl_number: cleaned });
      if (carrierValue) params.set("carrier", carrierValue);
      const payload = await apiRequest(`/api/track?${params.toString()}`);
      setTracked(payload);
      setRecent((prev) => [
        { bl: cleaned, carrier: carrierValue, status: payload.status, searchedAt: new Date().toISOString() },
        ...prev.filter((item) => item.bl !== cleaned)
      ].slice(0, 5));
    } catch (err) {
      setTracked(null);
      setTrackError(err.message || "Something went wrong while tracking this shipment.");
    } finally {
      setTrackLoading(false);
    }
  }

  function trackFromList(bl) {
    setDrawerRow(null);
    setCarrier("");
    if (route.view !== "track") navigate("track");
    window.scrollTo({ top: 0 });
    trackShipment(bl, "");
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
        title: payload.action === "created" ? `BL ${bl} added to the register` : `Register updated for BL ${bl}`,
        text: `Row ${(payload.rowsUpdated || []).join(", ")}${payload.fieldsUpdated?.length ? ` · ${payload.fieldsUpdated.join(", ")}` : ""}`
      });
      await Promise.all([loadShipments(), loadNotifications(), loadExcel()]);
      return true;
    } catch (err) {
      setNotice({ type: "error", title: "Register was not updated", text: err.message });
      return false;
    } finally {
      setSavingExcel(false);
    }
  }

  async function deleteRow(row, bl) {
    const payload = await apiRequest("/api/register/delete", { method: "POST", body: JSON.stringify({ rows: [row] }) });
    setHighlightRows([]);
    setNotice({ type: "success", title: `Row ${row} deleted`, text: `${bl ? `BL ${bl}. ` : ""}${payload.deleted} row removed from the register.` });
    await reloadAll();
  }

  const openRow = useCallback((rowOrShipment) => setDrawerRow(typeof rowOrShipment === "number" ? rowOrShipment : rowOrShipment.row), []);
  const closeDrawer = useCallback(() => setDrawerRow(null), []);
  const drawerShipment = drawerRow !== null ? shipments.data?.shipments.find((s) => s.row === drawerRow) : null;

  const track = {
    blNumber, setBlNumber, carrier, setCarrier,
    loading: trackLoading, error: trackError, shipment: tracked, saving: savingExcel, notice, recent,
    onSubmit: () => trackShipment(),
    onRefresh: () => trackShipment(lastSearched, carrier),
    onSave: () => syncToExcel(tracked.shipmentNumber || lastSearched, carrier),
    onClear: () => { setTracked(null); setTrackError(""); setNotice(null); setBlNumber(""); },
    onDismissError: () => setTrackError(""),
    onDismissNotice: () => setNotice(null),
    onOpenRegister: () => navigate("register"),
    onPickRecent: (item) => { setCarrier(item.carrier || ""); trackShipment(item.bl, item.carrier || ""); },
    onClearRecent: () => setRecent([])
  };

  const healthState = health === null ? "" : !health ? "offline" : health.apiKeyConfigured ? "ok" : "warn";
  const healthText = { offline: "Service offline", warn: "Tracking API key missing", ok: "Tracking API connected" }[healthState];

  return (
    <div className={`app ${collapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        route={route}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
      />

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMobileNav(true)} aria-label="Open menu"><List size={20} /></button>
          <span className="topbar-title">Shipping Tracking</span>
          <div className="topbar-right">
            {healthState && healthState !== "ok" && <span className={`health health-${healthState}`}>{healthText}</span>}
            {healthState === "ok" && <span className="health-dot" title={healthText} aria-label={healthText} />}
            <NotificationBell data={notifications} onChanged={reloadAll} onOpenRow={openRow} />
          </div>
        </header>

        <main className="page">
          {shipments.error && !shipments.data && route.view !== "register" && (
            <p className="form-error">Could not load the register: {shipments.error}</p>
          )}
          {route.view === "dashboard" && <Dashboard data={shipments.data} onOpen={openRow} />}
          {route.view === "track" && (
            <TrackView category={route.sub} onCategory={(sub) => navigate("track", sub)} data={shipments.data} onOpen={openRow} onTrack={trackFromList} track={track} />
          )}
          {route.view === "agents" && <AgentsView data={shipments.data} onOpen={openRow} onTrack={trackFromList} />}
          {route.view === "register" && (
            <RegisterView
              excel={excel}
              showAll={excelAll}
              onToggleAll={setExcelAll}
              onReload={loadExcel}
              onSync={syncToExcel}
              onDelete={deleteRow}
              onTrack={trackFromList}
              savingExcel={savingExcel}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              highlightRows={highlightRows}
            />
          )}
        </main>
      </div>

      {drawerShipment && <ShipmentDrawer shipment={drawerShipment} onClose={closeDrawer} onSaved={reloadAll} onTrack={trackFromList} />}
      <NotificationPopup data={notifications} onChanged={reloadAll} onOpenRow={openRow} />
    </div>
  );
}
