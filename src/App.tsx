import { useEffect, useMemo, useState } from "react";
import { loadState, saveState } from "./lib/storage";

/* ========================
   Types
======================== */
type ID = string;

type Bucket = {
  id: ID;
  name: string;
  allocations: Record<string, number>; // monthKey -> allocation
  isIncome?: boolean;
  deletedMonths?: Record<string, boolean>;
};

type Txn = {
  id: ID;
  date: string;            // YYYY-MM-DD
  description: string;
  amount: number;          // negative = expense; positive = income/credit
  bucketId: ID | null;
  deleted?: boolean;
};

type AppState = { buckets: Bucket[]; txns: Txn[] };

/* ========================
   Utils
======================== */
function uid(): ID { return Math.random().toString(36).slice(2, 10); }
function monthKey(dt: Date) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`; }
function monthKeyFrom(dateISO: string) { return dateISO.slice(0, 7); }
function fmtCurrency(n: number) { return n.toLocaleString(undefined, { style: "currency", currency: "USD" }); }
function today(delta = 0) { const d = new Date(); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); }
function fmtPretty(dateISO: string) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

// pull a merchant-y title from the raw description
function extractTitle(desc: string) {
  // examples: "TUMBLE 22 AUSTIN TX 1234" -> "TUMBLE 22"
  const m = desc.match(/^([A-Za-z0-9'&\-\.\s]{3,}?)(?:\s+(?:TX|CA|NY|[A-Z]{2})\b|\s+\d{2,}|\s+-|$)/i);
  return (m?.[1] || desc).trim();
}

/* ========================
   Seed
======================== */
function seedState(): AppState {
  const mkNow = monthKey(new Date());
  return {
    buckets: [
      { id: "income", name: "Income", allocations: {}, isIncome: true },
      { id: "b1", name: "Groceries", allocations: { [mkNow]: 600 } },
      { id: "b2", name: "Rent", allocations: { [mkNow]: 1500 } },
      { id: "b3", name: "Gas", allocations: { [mkNow]: 250 } },
      { id: "b4", name: "Date Night", allocations: { [mkNow]: 150 } },
    ],
    txns: [
      { id: uid(), date: today(-25), description: "Paycheck", amount: 3200, bucketId: "income" },
      { id: uid(), date: today(-20), description: "Rent", amount: -1500, bucketId: "b2" },
      { id: uid(), date: today(-8), description: "Paycheck", amount: 3500, bucketId: "income" },
      { id: uid(), date: today(-6), description: "HEB", amount: -84.12, bucketId: null },
      { id: uid(), date: today(-5), description: "Shell Gas", amount: -45.53, bucketId: null },
      { id: uid(), date: today(-2), description: "TUMBLE 22 AUSTIN TX 1234", amount: -28.5, bucketId: "b4" },
    ],
  };
}

/* ========================
   CSV parsing (STRICT 3 columns)
   column 0: Date
   column 1: Description
   column 2: Amount
======================== */
function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function normalizeToISO(raw: string): string {
  const dt = new Date(raw);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return today();
}
function parseCSV_3col(content: string): Txn[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  // allow header or headerless; we ALWAYS map [0]=date,[1]=desc,[2]=amount
  const start = lines.length > 0 && /date/i.test(lines[0]) ? 1 : 0;
  const txns: Txn[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 3) continue;
    const rawDate = cols[0];
    const desc = cols[1];
    let amtStr = cols[2];
    // handle ($12.34) and currency symbols
    if (/^\(.*\)$/.test(amtStr)) amtStr = "-" + amtStr.replace(/[()]/g, "");
    const amount = Number(amtStr.replace(/[^0-9\.-]/g, "")) || 0;
    txns.push({ id: uid(), date: normalizeToISO(rawDate), description: desc, amount, bucketId: null });
  }
  return txns;
}

/* ========================
   App
======================== */
export default function App() {
  // Cloud creds (memory only)
  const [householdId, setHouseholdId] = useState<string>("");
  const [passphrase, setPassphrase] = useState<string>("");

  // Modal
  const [connectOpen, setConnectOpen] = useState(false);

  // Core state + persistence
  const [state, setState] = useState<AppState>(() => seedState());
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await loadState(householdId || null, passphrase || null);
      if (s) setState(s);
      setLoadedOnce(true);
    })();
  }, [householdId, passphrase]);

  useEffect(() => {
    if (!loadedOnce) return;
    (async () => { await saveState(state, householdId || null, passphrase || null); })();
  }, [state, householdId, passphrase, loadedOnce]);

  // Month handling + carry-forward allocations
  const [monthOffset, setMonthOffset] = useState(0);
  const centerDate = new Date(); centerDate.setMonth(centerDate.getMonth() + monthOffset);
  const activeMonthKey = monthKey(centerDate);

  useEffect(() => {
    // seed allocations for this month from the most recent earlier month
    setState((s) => {
      const updated = s.buckets.map((b) => {
        if (b.allocations[activeMonthKey] !== undefined) return b;
        const prevKeys = Object.keys(b.allocations).filter((k) => k < activeMonthKey).sort();
        const prev = prevKeys[prevKeys.length - 1];
        const carry = prev ? b.allocations[prev] : 0;
        return { ...b, allocations: { ...b.allocations, [activeMonthKey]: carry } };
      });
      return { ...s, buckets: updated };
    });
  }, [activeMonthKey]);

  // Derived
  const incomeBucket = state.buckets.find((b) => b.isIncome)!;
  const nonIncomeBuckets = state.buckets.filter((b) => !b.isIncome && !(b.deletedMonths && b.deletedMonths[activeMonthKey]));

  const monthTxns = useMemo(
    () => state.txns.filter((t) => monthKeyFrom(t.date) === activeMonthKey && !t.deleted),
    [state.txns, activeMonthKey]
  );

  const totals = useMemo(() => {
    const income = monthTxns.filter((t) => t.bucketId === incomeBucket.id).reduce((s, t) => s + t.amount, 0);
    const allocated = nonIncomeBuckets.reduce((sum, b) => sum + (b.allocations[activeMonthKey] || 0), 0);
    const spent = monthTxns.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    const savings = income - spent;
    return { income, allocated, spent, savings };
  }, [monthTxns, incomeBucket.id, nonIncomeBuckets, activeMonthKey]);

  const unassigned = useMemo(() => monthTxns.filter((t) => t.bucketId === null), [monthTxns]);
  const assigned = useMemo(() => monthTxns.filter((t) => t.bucketId !== null), [monthTxns]);
  const deleted = useMemo(() => state.txns.filter((t) => !!t.deleted && monthKeyFrom(t.date) === activeMonthKey), [state.txns, activeMonthKey]);

  // Pulse state per bucket (id -> boolean)
  const [pulsing, setPulsing] = useState<Record<string, number>>({}); // stores timestamp to retrigger CSS

  function triggerPulse(bucketId: ID) {
    setPulsing((m) => ({ ...m, [bucketId]: Date.now() }));
  }

  // Amount left per bucket for month
  function leftFor(bucket: Bucket): number {
    const sumAssigned = monthTxns.filter((t) => t.bucketId === bucket.id).reduce((s, t) => s + t.amount, 0);
    return (bucket.allocations[activeMonthKey] || 0) + sumAssigned;
  }

  // Actions
  function updateAlloc(bucketId: ID, value: number) {
    setState((s) => ({
      ...s,
      buckets: s.buckets.map((b) =>
        b.id === bucketId
          ? { ...b, allocations: { ...b.allocations, [activeMonthKey]: value } }
          : b
      ),
    }));
  }
  function addBucket(name: string, alloc: number) {
    if (!name) return;
    const id = uid();
    setState((s) => ({ ...s, buckets: [...s.buckets, { id, name, allocations: { [activeMonthKey]: alloc } }] }));
  }
  function deleteBucketForMonth(bucketId: ID) {
    setState((s) => ({
      ...s,
      buckets: s.buckets.map((b) => b.id === bucketId ? { ...b, deletedMonths: { ...(b.deletedMonths || {}), [activeMonthKey]: true } } : b),
    }));
  }
  function reassignTxn(id: ID, bucketId: ID | null) {
    setState((s) => ({ ...s, txns: s.txns.map((t) => (t.id === id ? { ...t, bucketId } : t)) }));
  }
  function softDeleteTxn(id: ID) {
    setState((s) => ({ ...s, txns: s.txns.map((t) => (t.id === id ? { ...t, deleted: true } : t)) }));
  }
  function restoreTxn(id: ID) {
    setState((s) => ({ ...s, txns: s.txns.map((t) => (t.id === id ? { ...t, deleted: false } : t)) }));
  }
  function deleteForever(id: ID) {
    setState((s) => ({ ...s, txns: s.txns.filter((t) => t.id !== id) }));
  }

  // Drag & drop
  function onDragStart(e: React.DragEvent, txnId: ID, fromUnassigned: boolean) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ txnId, fromUnassigned }));
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
  function onDropToBucket(e: React.DragEvent, bucketId: ID) {
    e.preventDefault();
    const payload = e.dataTransfer.getData("text/plain");
    if (!payload) return;
    const { txnId, fromUnassigned } = JSON.parse(payload);
    const txn = state.txns.find((t) => t.id === txnId);
    if (!txn) return;
    reassignTxn(txnId, bucketId);
    // Pulse only if moved from Unassigned and amount is negative
    if (fromUnassigned && txn.amount < 0) triggerPulse(bucketId);
  }

  // CSV import / export
  function importCSV(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const txns = parseCSV_3col(text);
      setState((s) => ({ ...s, txns: [...txns, ...s.txns] }));
    };
    reader.readAsText(file);
  }
  function exportJSON() {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `trowbridge-budget-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  // UI Components
  function SummaryCard({ title, value, variant, droppable, onDrop }:{
    title: string; value: number; variant?: "default"|"income"|"savings";
    droppable?: boolean; onDrop?: (e: React.DragEvent) => void;
  }) {
    const base = "flex flex-col gap-1 rounded-2xl border p-4 shadow-sm select-none";
    const styles = {
      default: `${base} bg-white/70`,
      income: `${base} bg-white/70`,
      savings: `${base} bg-gradient-to-br from-[#f3e7e0] to-[#e7d2f5] border-transparent`,
    } as const;
    return (
      <div
        className={styles[variant || "default"]}
        onDragOver={droppable ? onDragOver : undefined}
        onDrop={droppable && onDrop ? onDrop : undefined}
        title={droppable ? "Drag transactions here" : undefined}
      >
        <div className={`text-sm ${variant === "income" ? "text-emerald-700" : "text-gray-500"}`}>{title}</div>
        <div className={`text-2xl font-semibold ${variant === "income" ? "text-emerald-700" : ""}`}>{fmtCurrency(value)}</div>
      </div>
    );
  }

  function BucketTile({ bucket }: { bucket: Bucket }) {
    const left = leftFor(bucket);
    const isNeg = left < 0;
    const [editing, setEditing] = useState(false);
    const [tmp, setTmp] = useState<number>(bucket.allocations[activeMonthKey] || 0);
    useEffect(() => setTmp(bucket.allocations[activeMonthKey] || 0), [bucket.allocations, activeMonthKey]);

    const pulseKey = pulsing[bucket.id]; // timestamp to retrigger animation
    return (
      <div
        className={`group relative rounded-2xl border bg-white/70 p-4 shadow-sm transition hover:shadow-md ${pulseKey ? "animate-[wipe_420ms_linear_1]" : ""}`}
        onDragOver={onDragOver}
        onDrop={(e) => onDropToBucket(e, bucket.id)}
      >
        {/* keyframes for bucket wipe */}
        <style>{`@keyframes wipe {0%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}20%{box-shadow:inset 9999px 0 0 0 rgba(190,100,255,.08)}60%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}100%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}}`}</style>
        <div className="flex items-start justify-between">
          <div className="font-medium">{bucket.name}</div>
          <div className="text-right">
            {!editing ? (
              <button
                className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
                onClick={() => setEditing(true)}
                title="Edit amount"
              >
                {fmtCurrency(bucket.allocations[activeMonthKey] || 0)}
              </button>
            ) : (
              <input
                type="number"
                value={tmp}
                onChange={(e) => setTmp(Number(e.target.value || 0))}
                onBlur={() => { updateAlloc(bucket.id, Number(tmp || 0)); setEditing(false); }}
                className="w-28 rounded-lg border px-2 py-1 text-right text-sm"
                autoFocus
              />
            )}
          </div>
        </div>
        <div className={`mt-6 text-center text-3xl font-semibold ${isNeg ? "text-gray-500" : "text-emerald-700"}`}>
          {fmtCurrency(left)}
        </div>
      </div>
    );
  }

  function BucketSelect({ value, onChange, buckets }: { value: ID | null; onChange: (id: ID | null) => void; buckets: Bucket[] }) {
    return (
      <select className="rounded-md border px-2 py-1 text-[12px]" value={value ?? ""} onChange={(e) => onChange(e.target.value ? e.target.value : null)}>
        <option value="">Unassigned</option>
        {buckets.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
      </select>
    );
  }

  function TxnCard({ t }: { t: Txn }) {
    const [editing, setEditing] = useState(false);
    const [open, setOpen] = useState(false);
    const amtClass = t.amount < 0 ? "text-gray-600" : "text-emerald-700";
    const title = extractTitle(t.description);
    return (
      <div
        draggable={!t.deleted}
        onDragStart={(e) => onDragStart(e, t.id, t.bucketId === null)}
        className={`flex items-center justify-between gap-3 rounded-xl border bg-white/80 px-4 py-3 text-sm shadow-sm ${t.deleted ? "opacity-60" : "cursor-grab active:cursor-grabbing"}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">{fmtPretty(t.date)}</div>
            <div className="font-medium truncate">{title}</div>
            <button className="ml-1 text-[11px] text-gray-500 hover:underline" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Details"}</button>
          </div>
          {open && (
            <div className="mt-1 text-[12px] text-gray-600">
              {!editing ? (
                <div onClick={() => setEditing(true)} title="Click to edit description">{t.description}</div>
              ) : (
                <input
                  autoFocus
                  type="text"
                  value={t.description}
                  onChange={(e) => setState((s) => ({ ...s, txns: s.txns.map((x) => x.id === t.id ? { ...x, description: e.target.value } : x) }))}
                  onBlur={() => setEditing(false)}
                  className="mt-1 w-full rounded-md border px-2 py-1 text-[12px]"
                />
              )}
            </div>
          )}
        </div>
        <div className={`whitespace-nowrap font-semibold ${amtClass}`}>{fmtCurrency(t.amount)}</div>
        {!t.deleted ? (
          <div className="flex items-center gap-2">
            <BucketSelect value={t.bucketId} onChange={(b) => reassignTxn(t.id, b)} buckets={state.buckets.filter((b) => !b.isIncome)} />
            <button className="rounded-md border px-2 py-1 text-[12px] transition-colors hover:border-red-500 hover:text-red-600 hover:bg-red-50" onClick={() => softDeleteTxn(t.id)}>Delete</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button className="rounded-md border px-2 py-1 text-[12px]" onClick={() => restoreTxn(t.id)}>Restore</button>
            <button className="rounded-md border px-2 py-1 text-[12px]" onClick={() => deleteForever(t.id)}>Delete forever</button>
          </div>
        )}
      </div>
    );
  }

  function BucketDetail({ bucket, onClose }: { bucket: Bucket; onClose: () => void }) {
    const txns = monthTxns.filter((t) => t.bucketId === bucket.id);
    const left = leftFor(bucket);
    return (
      <div className="fixed inset-0 z-40 flex justify-end bg-black/20">
        <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Bucket</div>
              <div className="text-xl font-semibold">{bucket.name}</div>
            </div>
            <button className="rounded-md border px-3 py-2" onClick={onClose}>Close</button>
          </div>
          <div className={`mb-4 text-2xl font-semibold ${left < 0 ? "text-gray-600" : "text-emerald-700"}`}>{fmtCurrency(left)} left</div>
          <div className="space-y-2">
            {txns.length === 0 ? (
              <div className="text-sm text-gray-400">No items yet. Drag transactions from the main view.</div>
            ) : (
              txns.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-xl border bg-white/80 px-3 py-2 text-sm shadow-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-600">{extractTitle(t.description)}</div>
                    <div className="text-[11px] font-medium text-blue-700">{fmtPretty(t.date)}</div>
                  </div>
                  <div className={`whitespace-nowrap font-semibold ${t.amount < 0 ? "text-gray-600" : "text-emerald-700"}`}>{fmtCurrency(t.amount)}</div>
                  <button className="ml-2 rounded-md border px-2 py-1 text-[12px]" onClick={() => reassignTxn(t.id, null)}>Unassign</button>
                </div>
              ))
            )}
          </div>
          <button className="mt-6 rounded-md bg-red-600 px-3 py-2 text-white" onClick={() => { deleteBucketForMonth(bucket.id); onClose(); }}>
            Delete bucket for {activeMonthKey}
          </button>
        </div>
      </div>
    );
  }

  function MonthScroller() {
    const boxes = Array.from({ length: 7 }, (_, i) => i - 3); // -3..+3
    return (
      <div className="mb-4 flex items-center justify-center gap-2">
        {boxes.map((offset) => {
          const dt = new Date(centerDate); dt.setMonth(dt.getMonth() + offset);
          const isCenter = offset === 0;
          const key = monthKey(dt);
          const mTxns = state.txns.filter((t) => monthKeyFrom(t.date) === key && !t.deleted);
          const spent = mTxns.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
          const income = mTxns.filter((t) => t.bucketId === incomeBucket.id).reduce((s, t) => s + t.amount, 0);
          const saved = income - spent;
          const isFuture = dt > new Date();
          return (
            <button
              key={offset}
              className={`w-36 rounded-2xl border p-3 text-left transition ${isCenter ? "scale-105 ring-2 ring-indigo-400 bg-white" : "bg-white/70"}`}
              onClick={() => setMonthOffset((n) => n + offset)}
              title={isFuture ? "Plan budgets for this month" : `Spent ${fmtCurrency(spent)} • Saved ${fmtCurrency(saved)}`}
            >
              <div className="flex items-baseline justify-between">
                <div className="text-sm font-semibold text-gray-600">{dt.toLocaleDateString(undefined, { month: "short" })}</div>
                {isFuture && <div className="text-[10px] text-indigo-500">Future</div>}
              </div>
              {!isFuture ? (
                <div className="mt-2 text-[12px] text-gray-600">
                  <div>Spent: {fmtCurrency(spent)}</div>
                  <div>Saved: {fmtCurrency(saved)}</div>
                </div>
              ) : (
                <div className="mt-2 text-[12px] text-gray-500">Plan budgets →</div>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // Local UI state
  const [activeBucketId, setActiveBucketId] = useState<ID | null>(null);
  const [showAllUnassigned, setShowAllUnassigned] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState(""); const [newAlloc, setNewAlloc] = useState("0");

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      {/* Top bar */}
      <div className="mx-auto mb-4 flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div className="text-2xl font-bold">Trowbridge Family Budget ✨</div>
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border bg-white/70 px-3 py-2 text-sm shadow-sm hover:bg-white">
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importCSV(f); e.currentTarget.value = ""; }} />
            Import CSV
          </label>
          <button className="rounded-lg border bg-white/70 px-3 py-2 text-sm shadow-sm hover:bg-white" onClick={exportJSON}>Export Data</button>
          <button
            className={`rounded-lg border px-3 py-2 text-sm shadow-sm ${householdId && passphrase ? "bg-emerald-50 border-emerald-300 text-emerald-700" : "bg-white/70"}`}
            onClick={() => setConnectOpen(true)}
          >
            {householdId && passphrase ? "Cloud: Connected" : "Cloud: Connect"}
          </button>
        </div>
      </div>

      {/* Month scroller */}
      <MonthScroller />

      {/* Row 1 – Summary (Income is a drop target) */}
      <div className="mx-auto mb-6 grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          title="Income"
          value={totals.income}
          variant="income"
          droppable
          onDrop={(e) => onDropToBucket(e, incomeBucket.id)}
        />
        <SummaryCard title="Budget" value={totals.allocated} />
        <SummaryCard title="Spent" value={totals.spent} />
        <SummaryCard title="Savings" value={totals.savings} variant="savings" />
      </div>

      {/* Row 2+ – Buckets grid (no Income here) */}
      <div className="mx-auto mb-8 max-w-6xl">
        <div className="mb-3 text-sm font-semibold text-gray-500">Buckets</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {nonIncomeBuckets.map((b) => (
            <div key={b.id} onClick={() => setActiveBucketId(b.id)}>
              <BucketTile bucket={b} />
            </div>
          ))}
          <button onClick={() => setAddOpen(true)} className="flex h-32 items-center justify-center rounded-2xl border border-dashed bg-white/50 p-4 text-gray-500 hover:bg-white/70">
            <div className="text-center">
              <div className="text-4xl leading-none">＋</div>
              <div className="text-sm">Add Bucket</div>
            </div>
          </button>
        </div>
      </div>

      {/* Row 3 – Unassigned */}
      <div className="mx-auto mb-8 max-w-6xl">
        <div className="mb-3 text-sm font-semibold text-gray-500">Unassigned</div>
        <div className="flex flex-col gap-2">
          {(showAllUnassigned ? unassigned : unassigned.slice(0, 4)).map((t) => (<TxnCard key={t.id} t={t} />))}
        </div>
        {unassigned.length > 4 && (
          <button className="mt-2 text-sm text-indigo-600 hover:underline" onClick={() => setShowAllUnassigned((v) => !v)}>
            {showAllUnassigned ? "Show less" : `View all (${unassigned.length - 4} more)`}
          </button>
        )}
      </div>

      {/* Row 4 – All Transactions */}
      <div className="mx-auto mb-8 max-w-6xl">
        <div className="mb-3 text-sm font-semibold text-gray-500">All Transactions</div>
        <div className="flex flex-col gap-2">
          {[...assigned, ...unassigned].map((t) => (<TxnCard key={t.id} t={t} />))}
        </div>
      </div>

      {/* Row 5 – Deleted */}
      <div className="mx-auto mb-16 max-w-6xl">
        <div className="mb-3 text-sm font-semibold text-gray-500">Deleted</div>
        {deleted.length === 0 ? (
          <div className="text-sm text-gray-400">No deleted transactions</div>
        ) : (
          <div className="flex flex-col gap-2">{deleted.map((t) => (<TxnCard key={t.id} t={t} />))}</div>
        )}
      </div>

      {/* Bucket detail */}
      {activeBucketId && (
        <BucketDetail bucket={state.buckets.find((b) => b.id === activeBucketId)!} onClose={() => setActiveBucketId(null)} />
      )}

      {/* Add bucket modal */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl border bg-white p-6 shadow-xl">
            <div className="mb-4 text-lg font-semibold">Add Bucket</div>
            <div className="flex flex-col gap-3">
              <input className="w-full rounded-md border px-3 py-2" placeholder="Bucket name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input className="w-full rounded-md border px-3 py-2" placeholder="Amount" type="number" value={newAlloc} onChange={(e) => setNewAlloc(e.target.value)} />
              <div className="flex justify-end gap-2">
                <button className="rounded-md border px-3 py-2" onClick={() => setAddOpen(false)}>Cancel</button>
                <button className="rounded-md bg-indigo-600 px-3 py-2 text-white" onClick={() => { addBucket(newName.trim(), Number(newAlloc || 0)); setNewName(""); setNewAlloc("0"); setAddOpen(false); }}>Add</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cloud Connect modal */}
      {connectOpen && (
        <CloudModal
          initialHousehold={householdId}
          initialPassphrase={passphrase}
          onClose={() => setConnectOpen(false)}
          onSave={(hh, pp) => { setHouseholdId(hh); setPassphrase(pp); setConnectOpen(false); }}
        />
      )}
    </div>
  );
}

/* ============== Cloud Modal (small, inline) ============== */
function CloudModal({ initialHousehold, initialPassphrase, onSave, onClose }:{
  initialHousehold: string; initialPassphrase: string;
  onSave: (hh: string, pp: string) => void; onClose: () => void;
}) {
  const [hh, setHh] = useState(initialHousehold);
  const [pp, setPp] = useState(initialPassphrase);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-2xl border bg-white p-6 shadow-xl">
        <div className="mb-3 text-lg font-semibold">Cloud: Connect</div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium">Household Code</label>
            <input className="mt-1 w-full rounded-md border px-3 py-2" placeholder="e.g. trowbridge-home" value={hh} onChange={(e) => setHh(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium">Passphrase</label>
            <input className="mt-1 w-full rounded-md border px-3 py-2" placeholder="Something only you two know" type="password" value={pp} onChange={(e) => setPp(e.target.value)} />
            <div className="mt-1 text-xs text-gray-500">Used only in your browser to encrypt/decrypt.</div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button className="rounded-md border px-3 py-2" onClick={onClose}>Cancel</button>
            <button className="rounded-md bg-indigo-600 px-3 py-2 text-white disabled:opacity-50" disabled={!hh.trim() || !pp.trim()} onClick={() => onSave(hh, pp)}>Save & Connect</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ title, value, variant, droppable, onDrop }:{
  title: string; value: number; variant?: "default"|"income"|"savings"; droppable?: boolean; onDrop?: (e: React.DragEvent) => void;
}) {
  const base = "flex flex-col gap-1 rounded-2xl border p-4 shadow-sm select-none";
  const styles = {
    default: `${base} bg-white/70`,
    income: `${base} bg-white/70`,
    savings: `${base} bg-gradient-to-br from-[#f3e7e0] to-[#e7d2f5] border-transparent`,
  } as const;
  return (
    <div className={styles[variant || "default"]} onDragOver={droppable ? (e)=>{e.preventDefault();} : undefined} onDrop={droppable && onDrop ? onDrop : undefined}>
      <div className={`text-sm ${variant === "income" ? "text-emerald-700" : "text-gray-500"}`}>{title}</div>
      <div className={`text-2xl font-semibold ${variant === "income" ? "text-emerald-700" : ""}`}>{fmtCurrency(value)}</div>
    </div>
  );
}
