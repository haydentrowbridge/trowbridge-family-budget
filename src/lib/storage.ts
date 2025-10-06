// src/lib/storage.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { encryptJSON, decryptJSON } from "./crypto";

// You can tighten this later; keeping it generic avoids coupling.
export type AppState = any;

const LOCAL_STORAGE_KEY = "trowbridge-budget-state";

function hasLocalStorage(): boolean {
  try { return typeof window !== "undefined" && !!window.localStorage; } catch { return false; }
}

// --- Local (offline-first) ---
export async function loadLocal(): Promise<AppState | null> {
  if (!hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export async function saveLocal(state: AppState): Promise<void> {
  if (!hasLocalStorage()) return;
  try { window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// --- Supabase client ---
function getSupabase(): SupabaseClient | null {
  const url = (window as any)?.SUPABASE_URL;
  const key = (window as any)?.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try { return createClient(url, key); } catch { return null; }
}
export function cloudAvailable(): boolean { return !!getSupabase(); }

// --- Cloud load/save (encrypted) ---
export async function loadFromCloud(householdId: string, passphrase: string): Promise<AppState | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data, error } = await sb.from("states").select("payload").eq("household_id", householdId).maybeSingle();
  if (error || !data) return null;
  const encryptedString = JSON.stringify(data.payload);
  const state = await decryptJSON(passphrase, encryptedString);
  return state;
}

export async function saveToCloud(householdId: string, passphrase: string, state: AppState): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  const encrypted = await encryptJSON(passphrase, state);
  const payload = JSON.parse(encrypted);
  const { error } = await sb.from("states").upsert({ household_id: householdId, payload });
  if (error) throw error;
}

// --- High-level API used by the app ---
export async function loadState(householdId: string | null, passphrase: string | null): Promise<AppState | null> {
  if (householdId && passphrase && cloudAvailable()) {
    const remote = await loadFromCloud(householdId, passphrase);
    if (remote) { await saveLocal(remote); return remote; }
  }
  return await loadLocal();
}
export async function saveState(state: AppState, householdId?: string | null, passphrase?: string | null): Promise<void> {
  await saveLocal(state);
  if (householdId && passphrase && cloudAvailable()) await saveToCloud(householdId, passphrase, state);
}
