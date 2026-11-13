import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./mock";
import type { Analysis, FindingChecks, FindingState, ProbeAnswer } from "./analysis";
import type { DraftComment } from "./components/DiffView";

export interface ChatItem {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  /** What the question was about (a finding, claim or file), shown as a small tag. */
  context?: string;
}

/** Everything the app remembers about one PR review, persisted across restarts. */
export interface PrSession {
  worktree?: string;
  sessionId?: string;
  analysis?: Analysis;
  analysisRaw?: string;
  analyzedAt?: number;
  /** Set when the last analysis covered only the changes after this commit (a re-review). */
  analysisSince?: string;
  /** The PR head the analysis looked at. */
  analysisHead?: string;
  /** Answers to guided review's predict-first questions, by `probeKey`. */
  probeAnswers?: Record<string, ProbeAnswer>;
  /** Findings re-checked after new commits. */
  findingChecks?: FindingChecks;
  /** Dismissed, resolved or commented findings, keyed by `findingId`. */
  findingStates?: Record<string, FindingState>;
  /** Comments written on selected diff lines, waiting for Submit review. */
  draftComments?: DraftComment[];
  headOid?: string;
  chat: ChatItem[];
  tokens?: number;
  costUsd?: number;
  inReview: number[];
  /** Hunks the user marked as reviewed (see `hunkKey`); drives step and file progress. */
  reviewedHunks?: string[];
}

const KEY = "better-lgtm.sessions";

/**
 * In the app, sessions are files in the app's data folder, one per pull request, so a long chat or a large
 * analysis can't run into the webview's storage limit. The browser preview keeps them in localStorage.
 */
let onDisk = inTauri;

function loadLocal(): Record<string, PrSession> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function emptySession(): PrSession {
  return { chat: [], inReview: [] };
}

// Chats and analyses change many times a second while Claude answers, so writes are batched,
// and only the sessions that changed are written.
let latest: Record<string, PrSession> = {};
const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();

async function write(keys: string[]) {
  if (!onDisk) {
    try {
      localStorage.setItem(KEY, JSON.stringify(latest));
    } catch {
      // storage full or unavailable: keep the in-memory copy
    }
    return;
  }
  await Promise.all(
    keys.map((key) =>
      (latest[key] ? invoke("session_save", { key, session: latest[key] }) : invoke("session_delete", { key })).catch((e) => {
        // Try again with the next change rather than losing it.
        dirty.add(key);
        console.error("Could not save the review session", key, e);
      }),
    ),
  );
}

/** Writes pending session changes now (before quitting or restarting). Never rejects. */
export function flushSessions(): Promise<void> {
  clearTimeout(saveTimer);
  if (!dirty.size) return saving;
  const keys = [...dirty];
  dirty.clear();
  // One write at a time, so an older copy of a session can't land after a newer one.
  saving = saving.then(() => write(keys)).catch(() => {});
  return saving;
}

function save(all: Record<string, PrSession>, key: string) {
  latest = all;
  dirty.add(key);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSessions, 800);
}

window.addEventListener("pagehide", () => void flushSessions());
window.addEventListener("beforeunload", () => void flushSessions());
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void flushSessions());

/** Sessions from disk. The first time, sessions from localStorage (before 0.5) move to disk. */
async function loadSessions(): Promise<Record<string, PrSession>> {
  if (!onDisk) return loadLocal();
  let saved: Record<string, PrSession>;
  try {
    saved = await invoke<Record<string, PrSession>>("sessions_load");
  } catch (e) {
    // No data folder to read: keep working from localStorage for this run.
    console.error("Could not read saved review sessions", e);
    onDisk = false;
    return loadLocal();
  }
  const old = loadLocal();
  const moved = Object.keys(old).filter((k) => !(k in saved));
  if (!moved.length) {
    // Everything in the old copy is on disk already.
    if (Object.keys(old).length) localStorage.removeItem(KEY);
    return saved;
  }
  latest = { ...old, ...saved };
  try {
    await Promise.all(moved.map((key) => invoke("session_save", { key, session: latest[key] })));
    localStorage.removeItem(KEY);
  } catch (e) {
    // The old copy stays in localStorage and moves on the next start.
    console.error("Could not move review sessions to disk", e);
  }
  return latest;
}

type Change = (s: PrSession) => PrSession;

export function useSessions() {
  const [sessions, setSessions] = useState<Record<string, PrSession>>(() => (onDisk ? {} : (latest = loadLocal())));
  /** False until saved sessions are read; nothing should conclude "this PR has no session" before that. */
  const [ready, setReady] = useState(!onDisk);
  // Changes made while the saved sessions are still loading, applied on top of them.
  const early = useRef<[string, Change][] | null>(onDisk ? [] : null);

  useEffect(() => {
    if (!early.current) return;
    let stale = false;
    loadSessions().then((saved) => {
      if (stale) return;
      let all = saved;
      for (const [key, fn] of early.current ?? []) {
        all = { ...all, [key]: fn(all[key] ?? emptySession()) };
        save(all, key);
      }
      early.current = null;
      latest = all;
      setSessions(all);
      setReady(true);
    });
    return () => {
      stale = true;
    };
  }, []);

  const update = useCallback((key: string, fn: Change) => {
    if (early.current) {
      early.current.push([key, fn]);
      return;
    }
    setSessions((all) => {
      const next = { ...all, [key]: fn(all[key] ?? emptySession()) };
      save(next, key);
      return next;
    });
  }, []);

  /** Forgets these sessions (the sample pull requests', when leaving the sample). */
  const remove = useCallback((keys: string[]) => {
    setSessions((all) => {
      const next = { ...all };
      for (const key of keys) {
        if (!(key in next)) continue;
        delete next[key];
        save(next, key);
      }
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setSessions({});
    latest = {};
    dirty.clear();
    clearTimeout(saveTimer);
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    if (onDisk) saving = saving.then(() => invoke<void>("sessions_clear")).catch((e) => console.error("Could not clear review sessions", e));
  }, []);

  return { sessions, update, remove, clearAll, ready };
}

export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set] as const;
}
