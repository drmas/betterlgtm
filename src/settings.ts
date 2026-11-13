import { useCallback, useEffect, useState } from "react";
import type { HarnessId } from "./harness";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  // General
  theme: Theme;
  /** Page zoom, as a factor: 1 is 100%. */
  zoom: number;
  refreshMinutes: number;
  autoUpdate: boolean;
  /** Single-letter, vim-style keys (j/k, h/l, gg, …) when no text field has focus. */
  vimKeys: boolean;
  /** Desktop notifications and the dock or taskbar count for review requests. */
  notifications: boolean;
  /** Send anonymous usage counts (app opens, reviews, actions) with no PR content. See telemetry.ts. */
  usageStats: boolean;
  // Organizations and review requests
  orgMode: "all" | "selected";
  /** Used in "all" mode: organizations left out of the inbox. */
  hiddenOrgs: string[];
  /** Used in "selected" mode: the only organizations shown. */
  selectedOrgs: string[];
  /** Repositories (owner/name) left out of the inbox, in any mode. */
  hiddenRepos: string[];
  includePersonal: boolean;
  includeTeams: boolean;
  showDrafts: boolean;
  // Review
  diffMode: "guided" | "files";
  diffLayout: "unified" | "split";
  hideGenerated: boolean;
  /** The reviewer's own globs for files to treat as generated, on top of the built-in list. */
  generatedPatterns: string[];
  /** Leave test and spec files out of the guided review and fold them in the Files view. The agent still reads them. */
  hideTests: boolean;
  /** Treat lines that differ only in whitespace as unchanged. */
  hideWhitespace: boolean;
  // The agent that runs reviews
  /** Which coding agent reads the code: Claude Code, Codex, Gemini CLI or Copilot CLI. */
  harness: HarnessId;
  /** Model name for the chosen agent. Empty means the agent's own default. */
  model: string;
  effort: string;
  reviewInstructions: string;
  /** Extra instructions for one repository (owner/name), added after the global ones. */
  repoInstructions: Record<string, string>;
  /** Analyze new review requests in the background. */
  autoAnalyze: boolean;
  /** When auto-analyze was turned on; only requests after this are analyzed automatically. */
  autoAnalyzeSince?: number;
  autoAnalyzeDrafts: boolean;
  /** How many analyses auto-analyze runs at once. */
  autoAnalyzeLimit: number;
  /** Most an automatic analysis may cost, in US dollars as Claude Code counts it. 0 means no limit. */
  autoAnalyzeBudgetUsd: number;
  /** A second pass tries to disprove the findings and drops the ones the code doesn't support. */
  verifyFindings: boolean;
  /** Guided review asks what you think a risky part does before explaining it (up to 2 per PR). */
  predictFirst: boolean;
  /** The first-run choices were made, or skipped. */
  onboarded: boolean;
  // Tools and storage
  ghPath: string;
  claudePath: string;
  /** Full paths to the other agents. Empty means the usual command name. */
  codexPath: string;
  geminiPath: string;
  copilotPath: string;
  dataDir: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  zoom: 1,
  refreshMinutes: 5,
  autoUpdate: true,
  vimKeys: true,
  notifications: true,
  usageStats: true,
  orgMode: "all",
  hiddenOrgs: [],
  selectedOrgs: [],
  hiddenRepos: [],
  includePersonal: true,
  includeTeams: true,
  showDrafts: true,
  diffMode: "guided",
  diffLayout: "unified",
  hideGenerated: true,
  generatedPatterns: [],
  hideTests: true,
  hideWhitespace: false,
  harness: "claude",
  model: "",
  effort: "",
  reviewInstructions: "",
  repoInstructions: {},
  autoAnalyze: false,
  autoAnalyzeDrafts: false,
  autoAnalyzeLimit: 1,
  autoAnalyzeBudgetUsd: 5,
  verifyFindings: true,
  predictFirst: false,
  onboarded: false,
  ghPath: "gh",
  claudePath: "claude",
  codexPath: "",
  geminiPath: "",
  copilotPath: "",
  dataDir: "",
};

const KEY = "better-lgtm.settings";

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    // Settings saved before onboarding existed belong to someone who already uses the app.
    if (saved) return { ...DEFAULT_SETTINGS, onboarded: true, ...saved };
    // Carry over values stored separately before the settings page existed.
    const old = (k: string) => JSON.parse(localStorage.getItem(`better-lgtm.${k}`) ?? "null");
    const first: Settings = {
      ...DEFAULT_SETTINGS,
      // An inbox that has loaded before also means the app is already in use.
      onboarded: localStorage.getItem("better-lgtm.inboxCache") !== null,
      hiddenOrgs: old("hiddenOrgs") ?? [],
      diffMode: old("diffMode") ?? DEFAULT_SETTINGS.diffMode,
      diffLayout: old("split") ? "split" : "unified",
    };
    // Saved at once, so a first run that's interrupted is still a first run next time.
    localStorage.setItem(KEY, JSON.stringify(first));
    return first;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  // Pick up changes made in another window (the macOS Settings window, or the main one).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setSettings(load());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // keep the in-memory copy
      }
      return next;
    });
  }, []);
  return [settings, update] as const;
}

/**
 * Whether a PR from `owner` belongs in the inbox. Owners that aren't one of the user's
 * organizations count as personal repositories (the user's own, or other people's).
 */
export function ownerVisible(s: Settings, owner: string, orgs: string[] | null): boolean {
  const isOrg = orgs ? orgs.includes(owner) : true;
  if (!isOrg) return s.includePersonal;
  return s.orgMode === "all" ? !s.hiddenOrgs.includes(owner) : s.selectedOrgs.includes(owner);
}

/** Zoom steps offered in Settings and walked by Zoom in and Zoom out. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2];

/** The next zoom step up (1) or down (-1) from `z`, staying within the steps. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  return next ?? z;
}
