import { useDeferredValue, useMemo, useState } from "react";
import { SearchField, ShipmentTable } from "../components.jsx";
import { ALERT_DAYS, matchesQuery } from "../lib.js";

const COLUMNS = ["date", "exitNo", "bl", "consignee", "destination", "eta", "telex"];
const NO_AGENT = "Not recorded";

export function AgentsView({ data, onOpen, onTrack }) {
  const [selected, setSelected] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query.trim().toLowerCase());

  // Agents are grouped case-insensitively; the most frequent spelling is shown.
  const agents = useMemo(() => {
    const groups = new Map();
    for (const s of data?.shipments || []) {
      const name = s.agent || NO_AGENT;
      const key = name.toUpperCase();
      if (!groups.has(key)) groups.set(key, { key, spellings: {}, shipments: [] });
      const g = groups.get(key);
      g.spellings[name] = (g.spellings[name] || 0) + 1;
      g.shipments.push(s);
    }
    return [...groups.values()]
      .map((g) => ({
        key: g.key,
        name: Object.entries(g.spellings).sort((a, b) => b[1] - a[1])[0][0],
        shipments: g.shipments.sort((a, b) => b.row - a.row),
        bls: new Set(g.shipments.map((s) => s.blKey).filter(Boolean)).size,
        arriving: g.shipments.filter((s) => s.etaDays !== null && s.etaDays >= 0 && s.etaDays <= ALERT_DAYS).length
      }))
      .sort((a, b) => (a.name === NO_AGENT) - (b.name === NO_AGENT) || b.shipments.length - a.shipments.length);
  }, [data]);

  const visibleAgents = agents.filter((a) => a.name.toLowerCase().includes(agentQuery.trim().toLowerCase()));
  const agent = agents.find((a) => a.key === selected) || visibleAgents[0];
  const rows = useMemo(() => (agent ? agent.shipments.filter((s) => matchesQuery(s, needle)) : []), [agent, needle]);

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Shipping agents</h1>
          <p className="muted">{agents.length} agents in the register. Pick one to see every shipment they handle.</p>
        </div>
      </header>

      <div className="split">
        <aside className="agent-list">
          <SearchField value={agentQuery} onChange={setAgentQuery} placeholder="Find agent" />
          <ul>
            {visibleAgents.map((a) => (
              <li key={a.key}>
                <button className={agent?.key === a.key ? "on" : ""} onClick={() => setSelected(a.key)} aria-current={agent?.key === a.key ? "true" : undefined}>
                  <span className="clamp">{a.name}</span>
                  <span className="count">{a.shipments.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="agent-detail">
          {agent ? (
            <>
              <div className="agent-head">
                <h2>{agent.name}</h2>
                <dl className="inline-stats">
                  <div><dt>Register rows</dt><dd>{agent.shipments.length}</dd></div>
                  <div><dt>BLs</dt><dd>{agent.bls}</dd></div>
                  <div><dt>Arriving in {ALERT_DAYS} days</dt><dd>{agent.arriving}</dd></div>
                </dl>
              </div>
              <div className="toolbar">
                <span />
                <SearchField value={query} onChange={setQuery} placeholder={`Search ${agent.name}'s shipments`} />
              </div>
              <ShipmentTable rows={rows} columns={COLUMNS} onOpen={onOpen} onTrack={onTrack} />
            </>
          ) : <p className="empty">{data ? "No agents match." : "Loading…"}</p>}
        </div>
      </div>
    </section>
  );
}
