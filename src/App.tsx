import { useEffect, useMemo, useState } from "react";
import { loadState, saveState } from "./lib/storage";

/* ========================
   Types
======================== */
type ID = string;

type Bucket = {
  id: ID;
  name: string;
  category?: string; // For grouping in analytics
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

type AppState = { 
  buckets: Bucket[]; 
  txns: Txn[];
  version?: number; // For future migrations
};

const CURRENT_VERSION = 1;

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
  const m = desc.match(/^([A-Za-z0-9'&\-\.\s]{3,}?)(?:\s+(?:TX|CA|NY|[A-Z]{2})\b|\s+\d{2,}|\s+-|$)/i);
  return (m?.[1] || desc).trim();
}

function seedState(): AppState {
  const now = new Date();
  const activeMonthKey = monthKey(now);
  return {
    buckets: [
      { id: "income", name: "Income", allocations: { [activeMonthKey]: 0 }, isIncome: true },
    ],
    txns: [],
    version: CURRENT_VERSION,
  };
}

// Migration function to handle future updates
function migrateState(state: AppState): AppState {
  let migrated = { ...state };
  
  // Add version if missing
  if (!migrated.version) {
    migrated.version = 1;
  }
  
  // Future migrations go here
  // if (migrated.version < 2) {
  //   // Perform migration from v1 to v2
  //   migrated = { ...migrated, newField: defaultValue };
  //   migrated.version = 2;
  // }
  
  return migrated;
}

/* ========================
   CSV Parsing
======================== */
function normalizeToISO(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return today();
  return dt.toISOString().slice(0, 10);
}
function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === "," && !inQuote) { out.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  out.push(cell.trim());
  return out;
}
function parseCSV_3col(text: string): Txn[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const hasHeader = /date|description|amount/i.test(lines[0]);
  const start = hasHeader ? 1 : 0;
  const txns: Txn[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 3) continue;
    const rawDate = cols[0];
    const desc = cols[1];
    let amtStr = cols[2];
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

  // Modals
  const [connectOpen, setConnectOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);

  // Core state + persistence
  const [state, setState] = useState<AppState>(() => seedState());
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    (async () => {
      let s = await loadState(householdId || null, passphrase || null);
      if (s) {
        // Migrate old data to current version
        s = migrateState(s);
        setState(s);
      }
      setLoadedOnce(true);
    })();
  }, [householdId, passphrase]);

  // Manual save function
  const manualSave = async () => {
    setIsSaving(true);
    try {
      await saveState(state, householdId || null, passphrase || null);
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Save failed:", error);
      alert("Failed to save. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  // Track changes
  useEffect(() => {
    if (loadedOnce) {
      setHasUnsavedChanges(true);
    }
  }, [state]);

  // Month handling + carry-forward allocations
  const [monthOffset, setMonthOffset] = useState(0);
  const centerDate = new Date(); centerDate.setMonth(centerDate.getMonth() + monthOffset);
  const activeMonthKey = monthKey(centerDate);

  useEffect(() => {
    // seed allocations for this month from the most recent earlier month
    // BUT only carry forward to FUTURE months, not backwards to past months
    setState((s) => {
      const updated = s.buckets.map((b) => {
        // If this month already has an allocation, leave it alone
        if (b.allocations[activeMonthKey] !== undefined) return b;
        
        // Get all months where this bucket has allocations
        const allocationKeys = Object.keys(b.allocations).sort();
        
        // If this bucket has no allocations at all, don't add one
        if (allocationKeys.length === 0) return b;
        
        // Find the first month this bucket was created
        const firstMonth = allocationKeys[0];
        
        // If we're navigating to a month BEFORE the bucket was created, don't show it
        if (activeMonthKey < firstMonth) return b;
        
        // Otherwise, carry forward from the most recent earlier month
        const prevKeys = allocationKeys.filter((k) => k < activeMonthKey);
        const prev = prevKeys[prevKeys.length - 1];
        const carry = prev ? b.allocations[prev] : 0;
        return { ...b, allocations: { ...b.allocations, [activeMonthKey]: carry } };
      });
      return { ...s, buckets: updated };
    });
  }, [activeMonthKey]);

  // Derived
  const incomeBucket = state.buckets.find((b) => b.isIncome)!;
  const nonIncomeBuckets = state.buckets.filter((b) => {
    if (b.isIncome) return false;
    if (b.deletedMonths && b.deletedMonths[activeMonthKey]) return false;
    return b.allocations[activeMonthKey] !== undefined;
  });

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

  // Pulse state per bucket
  const [pulsing, setPulsing] = useState<Record<string, number>>({});

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
  
  // ENHANCED: Add bucket with choice of scope
  function addBucket(name: string, alloc: number, addToAllFuture: boolean) {
    if (!name) return;
    const id = uid();
    
    if (addToAllFuture) {
      // Add to current month and all future months (next 12 months)
      const allocations: Record<string, number> = {};
      const currentDate = new Date(centerDate);
      
      for (let i = 0; i < 12; i++) {
        const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
        allocations[monthKey] = alloc;
        currentDate.setMonth(currentDate.getMonth() + 1);
      }
      
      setState((s) => ({ ...s, buckets: [...s.buckets, { id, name, allocations }] }));
    } else {
      // Add only for current month
      setState((s) => ({ ...s, buckets: [...s.buckets, { id, name, allocations: { [activeMonthKey]: alloc } }] }));
    }
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
  
  function exportCSV() {
    const lines: string[] = [];
    lines.push("Month,Bucket,Allocation,Transaction Date,Description,Amount");
    
    const months = new Set<string>();
    state.txns.forEach(t => {
      if (!t.deleted) {
        months.add(monthKeyFrom(t.date));
      }
    });
    
    const sortedMonths = Array.from(months).sort();
    
    sortedMonths.forEach(month => {
      const monthTxnsForExport = state.txns.filter(t => monthKeyFrom(t.date) === month && !t.deleted);
      
      state.buckets.forEach(bucket => {
        if (bucket.deletedMonths && bucket.deletedMonths[month]) return;
        
        const bucketTxns = monthTxnsForExport.filter(t => t.bucketId === bucket.id);
        const allocation = bucket.allocations[month] || 0;
        
        if (bucketTxns.length === 0) {
          lines.push(`"${month}","${bucket.name}","${allocation}","","",""`);
        } else {
          bucketTxns.forEach((txn, idx) => {
            const allocationStr = idx === 0 ? allocation.toString() : "";
            lines.push(`"${month}","${bucket.name}","${allocationStr}","${txn.date}","${txn.description.replace(/"/g, '""')}","${txn.amount}"`);
          });
        }
      });
      
      const unassignedTxns = monthTxnsForExport.filter(t => t.bucketId === null);
      unassignedTxns.forEach(txn => {
        lines.push(`"${month}","Unassigned","","${txn.date}","${txn.description.replace(/"/g, '""')}","${txn.amount}"`);
      });
    });
    
    const csvContent = lines.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trowbridge-budget-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
    
    useEffect(() => {
      setTmp(bucket.allocations[activeMonthKey] || 0);
    }, [bucket.allocations, activeMonthKey]);

    const pulseKey = pulsing[bucket.id];
    
    const handleSave = () => {
      updateAlloc(bucket.id, Number(tmp || 0));
      setEditing(false);
    };
    
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        setTmp(bucket.allocations[activeMonthKey] || 0);
        setEditing(false);
      }
    };
    
    return (
      <div
        className={`group relative rounded-2xl border bg-white/70 p-4 shadow-sm transition hover:shadow-md ${pulseKey ? "animate-[wipe_420ms_linear_1]" : ""}`}
        onDragOver={onDragOver}
        onDrop={(e) => onDropToBucket(e, bucket.id)}
      >
        <style>{`@keyframes wipe {0%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}20%{box-shadow:inset 9999px 0 0 0 rgba(190,100,255,.08)}60%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}100%{box-shadow:inset 0 0 0 0 rgba(190,100,255,.0)}}`}</style>
        <div className="flex items-start justify-between">
          <div className="font-medium">{bucket.name}</div>
          <div className="text-right">
            {!editing ? (
              <button
                className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
                onClick={() => setEditing(true)}
                title="Click to edit amount"
              >
                {fmtCurrency(bucket.allocations[activeMonthKey] || 0)}
              </button>
            ) : (
              <input
                type="number"
                value={tmp}
                onChange={(e) => setTmp(Number(e.target.value || 0))}
                onBlur={handleSave}
                onKeyDown={handleKeyDown}
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
                <div onClick={() => setEditing(true)} title="Click to edit description" className="cursor-pointer hover:bg-gray-50 rounded px-1">{t.description}</div>
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
    const [editingAlloc, setEditingAlloc] = useState(false);
    const [tmpAlloc, setTmpAlloc] = useState<number>(bucket.allocations[activeMonthKey] || 0);
    
    useEffect(() => {
      setTmpAlloc(bucket.allocations[activeMonthKey] || 0);
    }, [bucket.allocations, activeMonthKey]);
    
    const handleSaveAlloc = () => {
      updateAlloc(bucket.id, Number(tmpAlloc || 0));
      setEditingAlloc(false);
    };
    
    return (
      <div className="fixed inset-0 z-40 flex justify-end bg-black/20">
        <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-400">Bucket</div>
              <div className="text-xl font-semibold">{bucket.name}</div>
              <div className="mt-2 text-sm text-gray-600">
                Allocated: {!editingAlloc ? (
                  <button
                    className="ml-1 rounded-md px-2 py-1 text-sm font-semibold hover:bg-gray-100"
                    onClick={() => setEditingAlloc(true)}
                  >
                    {fmtCurrency(bucket.allocations[activeMonthKey] || 0)}
                  </button>
                ) : (
                  <input
                    type="number"
                    value={tmpAlloc}
                    onChange={(e) => setTmpAlloc(Number(e.target.value || 0))}
                    onBlur={handleSaveAlloc}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveAlloc();
                      if (e.key === 'Escape') {
                        setTmpAlloc(bucket.allocations[activeMonthKey] || 0);
                        setEditingAlloc(false);
                      }
                    }}
                    className="ml-1 w-28 rounded-lg border px-2 py-1 text-sm"
                    autoFocus
                  />
                )}
              </div>
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
    const boxes = Array.from({ length: 7 }, (_, i) => i - 3);
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
  const [newName, setNewName] = useState(""); 
  const [newAlloc, setNewAlloc] = useState("0");
  const [addToAllFuture, setAddToAllFuture] = useState(false);

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
          <button className="rounded-lg border bg-white/70 px-3 py-2 text-sm shadow-sm hover:bg-white" onClick={exportCSV}>Export CSV</button>
          <button className="rounded-lg border bg-white/70 px-3 py-2 text-sm shadow-sm hover:bg-white" onClick={exportJSON}>Export JSON</button>
          
          <button 
            className="rounded-lg border bg-purple-50 border-purple-300 px-3 py-2 text-sm shadow-sm hover:bg-purple-100 text-purple-700 font-semibold"
            onClick={() => setAnalyticsOpen(true)}
          >
            📊 Analytics
          </button>
          
          <button 
            className="rounded-lg border bg-yellow-50 border-yellow-300 px-3 py-2 text-sm shadow-sm hover:bg-yellow-100 text-yellow-700 font-semibold"
            onClick={() => setWhiteboardOpen(true)}
          >
            🧮 Whiteboard
          </button>
          
          <button 
            className={`rounded-lg border px-3 py-2 text-sm shadow-sm font-semibold ${
              hasUnsavedChanges 
                ? "bg-blue-600 text-white hover:bg-blue-700" 
                : "bg-emerald-50 border-emerald-300 text-emerald-700"
            }`}
            onClick={manualSave}
            disabled={isSaving}
          >
            {isSaving ? "Saving..." : hasUnsavedChanges ? "💾 Save Changes" : "✓ Saved"}
          </button>
          
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

      {/* Row 1 – Summary */}
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

      {/* Row 2+ – Buckets grid */}
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
            {showAllUnassigned ? `Show less (${unassigned.length - 4} hidden)` : `Show all (${unassigned.length - 4} more)`}
          </button>
        )}
      </div>

      {/* Row 4 – Deleted */}
      <div className="mx-auto mb-8 max-w-6xl">
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

      {/* Add bucket modal - ENHANCED with choice */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl border bg-white p-6 shadow-xl">
            <div className="mb-4 text-lg font-semibold">Add Bucket</div>
            <div className="flex flex-col gap-3">
              <input 
                className="w-full rounded-md border px-3 py-2" 
                placeholder="Bucket name" 
                value={newName} 
                onChange={(e) => setNewName(e.target.value)} 
              />
              <input 
                className="w-full rounded-md border px-3 py-2" 
                placeholder="Amount" 
                type="number" 
                value={newAlloc} 
                onChange={(e) => setNewAlloc(e.target.value)} 
              />
              
              {/* NEW: Choice of scope */}
              <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
                <div className="text-sm font-medium text-gray-700 mb-2">When should this bucket apply?</div>
                <label className="flex items-center gap-2 mb-2 cursor-pointer">
                  <input 
                    type="radio" 
                    name="bucketScope" 
                    checked={!addToAllFuture}
                    onChange={() => setAddToAllFuture(false)}
                    className="text-indigo-600"
                  />
                  <div>
                    <div className="text-sm font-medium">This month only</div>
                    <div className="text-xs text-gray-500">Will automatically carry forward when you navigate to future months</div>
                  </div>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input 
                    type="radio" 
                    name="bucketScope" 
                    checked={addToAllFuture}
                    onChange={() => setAddToAllFuture(true)}
                    className="text-indigo-600"
                  />
                  <div>
                    <div className="text-sm font-medium">All future months (next 12)</div>
                    <div className="text-xs text-gray-500">Creates the bucket in this month and the next 12 months</div>
                  </div>
                </label>
              </div>
              
              <div className="flex justify-end gap-2">
                <button className="rounded-md border px-3 py-2" onClick={() => { setAddOpen(false); setAddToAllFuture(false); }}>Cancel</button>
                <button 
                  className="rounded-md bg-indigo-600 px-3 py-2 text-white" 
                  onClick={() => { 
                    addBucket(newName.trim(), Number(newAlloc || 0), addToAllFuture); 
                    setNewName(""); 
                    setNewAlloc("0"); 
                    setAddToAllFuture(false);
                    setAddOpen(false); 
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Analytics Modal */}
      {analyticsOpen && (
        <AnalyticsDashboard 
          state={state} 
          activeMonthKey={activeMonthKey}
          onClose={() => setAnalyticsOpen(false)} 
        />
      )}

      {/* Whiteboard Modal */}
      {whiteboardOpen && (
        <WhiteboardModal 
          monthTxns={monthTxns}
          buckets={state.buckets}
          activeMonthKey={activeMonthKey}
          totals={totals}
          onClose={() => setWhiteboardOpen(false)} 
        />
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

/* ============== Analytics Dashboard ============== */
function AnalyticsDashboard({ state, activeMonthKey, onClose }: {
  state: AppState;
  activeMonthKey: string;
  onClose: () => void;
}) {
  // Get last 6 months of data
  const getLast6Months = () => {
    const months: string[] = [];
    const date = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(date);
      d.setMonth(d.getMonth() - i);
      months.push(monthKey(d));
    }
    return months;
  };

  const months = getLast6Months();
  
  // Calculate spending by bucket over time
  const spendingByBucket = useMemo(() => {
    const data: Record<string, Record<string, number>> = {};
    
    state.buckets.forEach(bucket => {
      if (bucket.isIncome) return;
      data[bucket.name] = {};
      
      months.forEach(month => {
        const monthTxns = state.txns.filter(t => 
          monthKeyFrom(t.date) === month && 
          t.bucketId === bucket.id && 
          !t.deleted &&
          t.amount < 0
        );
        data[bucket.name][month] = Math.abs(monthTxns.reduce((sum, t) => sum + t.amount, 0));
      });
    });
    
    return data;
  }, [state, months]);

  // Calculate percentages for current month
  const currentMonthPercentages = useMemo(() => {
    const monthTxns = state.txns.filter(t => 
      monthKeyFrom(t.date) === activeMonthKey && 
      !t.deleted &&
      t.amount < 0
    );
    
    const totalSpent = Math.abs(monthTxns.reduce((sum, t) => sum + t.amount, 0));
    
    const byBucket: Record<string, { spent: number; percentage: number }> = {};
    
    state.buckets.forEach(bucket => {
      if (bucket.isIncome) return;
      
      const bucketTxns = monthTxns.filter(t => t.bucketId === bucket.id);
      const spent = Math.abs(bucketTxns.reduce((sum, t) => sum + t.amount, 0));
      const percentage = totalSpent > 0 ? (spent / totalSpent) * 100 : 0;
      
      if (spent > 0) {
        byBucket[bucket.name] = { spent, percentage };
      }
    });
    
    return { byBucket, totalSpent };
  }, [state, activeMonthKey]);

  // Calculate average monthly spending
  const averages = useMemo(() => {
    const bucketAverages: Record<string, number> = {};
    
    Object.entries(spendingByBucket).forEach(([bucketName, monthlyData]) => {
      const values = Object.values(monthlyData).filter(v => v > 0);
      const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      bucketAverages[bucketName] = avg;
    });
    
    return bucketAverages;
  }, [spendingByBucket]);

  // Calculate trends
  const trends = useMemo(() => {
    const trendData: Record<string, { direction: 'up' | 'down' | 'stable'; change: number }> = {};
    
    Object.entries(spendingByBucket).forEach(([bucketName, monthlyData]) => {
      const values = months.map(m => monthlyData[m] || 0);
      const recent = values.slice(-3).filter(v => v > 0);
      const previous = values.slice(-6, -3).filter(v => v > 0);
      
      if (recent.length > 0 && previous.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const prevAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
        const change = ((recentAvg - prevAvg) / prevAvg) * 100;
        
        let direction: 'up' | 'down' | 'stable' = 'stable';
        if (Math.abs(change) > 5) {
          direction = change > 0 ? 'up' : 'down';
        }
        
        trendData[bucketName] = { direction, change };
      }
    });
    
    return trendData;
  }, [spendingByBucket, months]);

  const sortedBuckets = Object.entries(currentMonthPercentages.byBucket)
    .sort((a, b) => b[1].percentage - a[1].percentage);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4">
      <div className="mx-auto max-w-4xl rounded-2xl border bg-white p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Analytics Dashboard</h2>
          <button className="rounded-md border px-3 py-2" onClick={onClose}>Close</button>
        </div>

        {/* Current Month Breakdown */}
        <div className="mb-8">
          <h3 className="mb-4 text-lg font-semibold">Current Month: Spending by Category</h3>
          <div className="space-y-3">
            {sortedBuckets.length === 0 ? (
              <div className="text-gray-400">No spending data for this month yet</div>
            ) : (
              sortedBuckets.map(([name, data]) => (
                <div key={name} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-600">
                      {fmtCurrency(data.spent)} ({data.percentage.toFixed(1)}%)
                    </div>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div 
                      className="h-full bg-indigo-500 transition-all"
                      style={{ width: `${data.percentage}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Trends */}
        <div className="mb-8">
          <h3 className="mb-4 text-lg font-semibold">Spending Trends (Last 6 Months)</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries(trends).map(([name, trend]) => (
              <div key={name} className="rounded-lg border p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-medium">{name}</div>
                  <div className={`text-2xl ${trend.direction === 'up' ? 'text-red-500' : trend.direction === 'down' ? 'text-green-500' : 'text-gray-400'}`}>
                    {trend.direction === 'up' ? '📈' : trend.direction === 'down' ? '📉' : '➡️'}
                  </div>
                </div>
                <div className="text-sm text-gray-600">
                  Average: {fmtCurrency(averages[name] || 0)}
                </div>
                <div className={`text-sm font-medium ${trend.direction === 'up' ? 'text-red-600' : trend.direction === 'down' ? 'text-green-600' : 'text-gray-500'}`}>
                  {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'} {Math.abs(trend.change).toFixed(1)}% vs previous 3 months
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Insights */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <h3 className="mb-2 font-semibold text-blue-900">💡 Insights</h3>
          <ul className="space-y-1 text-sm text-blue-800">
            {sortedBuckets.length > 0 && (
              <li>• Your top spending category is <strong>{sortedBuckets[0][0]}</strong> at {sortedBuckets[0][1].percentage.toFixed(1)}%</li>
            )}
            {Object.entries(trends).some(([_, t]) => t.direction === 'up') && (
              <li>• Some categories are trending upward - consider reviewing your budget</li>
            )}
            {Object.entries(trends).some(([_, t]) => t.direction === 'down') && (
              <li>• Great job reducing spending in some categories!</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ============== Whiteboard Modal ============== */
function WhiteboardModal({ monthTxns, buckets, activeMonthKey, totals, onClose }: {
  monthTxns: Txn[];
  buckets: Bucket[];
  activeMonthKey: string;
  totals: { income: number; allocated: number; spent: number; savings: number };
  onClose: () => void;
}) {
  const [calcInput, setCalcInput] = useState("");
  const [calcResult, setCalcResult] = useState<string>("");
  const [projections, setProjections] = useState({
    projectedIncome: totals.income,
    projectedExpenses: totals.spent,
    additionalSavingsGoal: 0,
  });

  const handleCalc = () => {
    try {
      // Simple eval for calculator (in production, use a proper math parser library)
      const result = Function(`'use strict'; return (${calcInput})`)();
      setCalcResult(result.toString());
    } catch (e) {
      setCalcResult("Error");
    }
  };

  const projectedSavings = projections.projectedIncome - projections.projectedExpenses;
  const savingsGoalDiff = projectedSavings - projections.additionalSavingsGoal;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4">
      <div className="mx-auto max-w-4xl rounded-2xl border bg-white p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Planning Whiteboard - {activeMonthKey}</h2>
          <button className="rounded-md border px-3 py-2" onClick={onClose}>Close</button>
        </div>

        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <strong>Note:</strong> This whiteboard is for planning only. Changes here do NOT affect your actual budget data.
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Left Column: Current Stats */}
          <div>
            <h3 className="mb-3 font-semibold">Current Month Stats</h3>
            <div className="space-y-2 rounded-lg border p-4 bg-gray-50">
              <div className="flex justify-between">
                <span>Income:</span>
                <span className="font-semibold text-emerald-700">{fmtCurrency(totals.income)}</span>
              </div>
              <div className="flex justify-between">
                <span>Spent:</span>
                <span className="font-semibold text-gray-600">{fmtCurrency(totals.spent)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span>Savings:</span>
                <span className="font-semibold text-indigo-600">{fmtCurrency(totals.savings)}</span>
              </div>
            </div>

            <h3 className="mb-3 mt-6 font-semibold">Spending Breakdown</h3>
            <div className="space-y-2">
              {buckets
                .filter(b => !b.isIncome && b.allocations[activeMonthKey])
                .map(bucket => {
                  const bucketTxns = monthTxns.filter(t => t.bucketId === bucket.id && t.amount < 0);
                  const spent = Math.abs(bucketTxns.reduce((sum, t) => sum + t.amount, 0));
                  return (
                    <div key={bucket.id} className="flex justify-between text-sm rounded border px-3 py-2">
                      <span>{bucket.name}</span>
                      <span className="font-medium">{fmtCurrency(spent)}</span>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Right Column: Projections & Calculator */}
          <div>
            <h3 className="mb-3 font-semibold">What-If Projections</h3>
            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <label className="block text-sm font-medium mb-1">Projected Income</label>
                <input
                  type="number"
                  className="w-full rounded-md border px-3 py-2"
                  value={projections.projectedIncome}
                  onChange={(e) => setProjections(p => ({ ...p, projectedIncome: Number(e.target.value) }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Projected Expenses</label>
                <input
                  type="number"
                  className="w-full rounded-md border px-3 py-2"
                  value={projections.projectedExpenses}
                  onChange={(e) => setProjections(p => ({ ...p, projectedExpenses: Number(e.target.value) }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Savings Goal</label>
                <input
                  type="number"
                  className="w-full rounded-md border px-3 py-2"
                  value={projections.additionalSavingsGoal}
                  onChange={(e) => setProjections(p => ({ ...p, additionalSavingsGoal: Number(e.target.value) }))}
                />
              </div>
              
              <div className="border-t pt-3 mt-3">
                <div className="flex justify-between mb-2">
                  <span className="font-medium">Projected Savings:</span>
                  <span className={`font-bold ${projectedSavings >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {fmtCurrency(projectedSavings)}
                  </span>
                </div>
                {projections.additionalSavingsGoal > 0 && (
                  <div className="flex justify-between text-sm">
                    <span>Goal difference:</span>
                    <span className={savingsGoalDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                      {savingsGoalDiff >= 0 ? '✓' : '✗'} {fmtCurrency(Math.abs(savingsGoalDiff))}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <h3 className="mb-3 mt-6 font-semibold">Quick Calculator</h3>
            <div className="rounded-lg border p-4">
              <input
                type="text"
                className="w-full rounded-md border px-3 py-2 mb-2 font-mono"
                placeholder="Enter calculation (e.g., 500 + 200 * 1.5)"
                value={calcInput}
                onChange={(e) => setCalcInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCalc()}
              />
              <button
                className="w-full rounded-md bg-indigo-600 px-3 py-2 text-white mb-2"
                onClick={handleCalc}
              >
                Calculate
              </button>
              {calcResult && (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-center">
                  <div className="text-sm text-emerald-700 font-medium">Result:</div>
                  <div className="text-2xl font-bold text-emerald-900">{calcResult}</div>
                </div>
              )}
              
              <div className="mt-4 grid grid-cols-4 gap-1">
                {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+'].map(btn => (
                  <button
                    key={btn}
                    className="rounded border bg-gray-50 px-3 py-2 hover:bg-gray-100"
                    onClick={() => {
                      if (btn === '=') {
                        handleCalc();
                      } else {
                        setCalcInput(prev => prev + btn);
                      }
                    }}
                  >
                    {btn}
                  </button>
                ))}
              </div>
              <button
                className="mt-2 w-full rounded border bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200"
                onClick={() => { setCalcInput(""); setCalcResult(""); }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============== Cloud Modal ============== */
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
