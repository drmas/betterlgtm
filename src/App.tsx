import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Code, Download, ExternalLink, History, FileDiff, GitBranch, GitPullRequestArrow, Inbox as InboxIcon, ListChecks, ListOrdered, Loader, Lock, MessageSquare, RefreshCw, RotateCw, Send, Terminal, TriangleAlert, Sparkles } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { parseDiff, type FileData } from "react-diff-view";
import { api, describeToolUse, errorText, isSampleMode, setSampleMode, type ClaudeEvent, type ToolStatus, type LastReview, type LinkedIssue, type PrDetails, type ReviewRequest, type ReviewThread } from "./api";
import { ANALYSIS_SCHEMA, RECHECK_SCHEMA, VERIFY_SCHEMA, WALKTHROUGH_SCHEMA, WALKTHROUGH_SCHEMA_PROBES, anchorLabel, answerOf, applyVerification, carryFindingIds, findingId, keepAnswers, worthVerifying, type Analysis, type WalkStep, type EarlierFinding, type Finding, type RepoDismissal, type FindingState, buildAnalysisPrompt, buildDescriptionPrompt, buildReplyPrompt, buildSummaryPrompt, buildRecheckPrompt, buildVerifyPrompt, buildWalkthroughPrompt, parseAnalysis, parseRecheck, parseVerify, parseWalkthrough, type Anchor } from "./analysis";
import type { OutlineKey, RunState } from "./components/AnalysisView";
import { ClaudePanel, type ChatContext } from "./components/ClaudePanel";
import type { DiffMode } from "./components/DiffView";
import { AnalysisView, CommandPalette, DescriptionDialog, DiffView, FilterDialog, GuidedReview, InfoDialog, Onboarding, preloadViews, Settings, SubmitReview, WhatsNew } from "./lazy";
import { appVersion, hasNotes, versionToAnnounce } from "./whatsNew";
import { AgentContext, harnessOf } from "./harness";
import { setupBroken } from "./setup";
import { Inbox, InboxRail, prKey, type InboxView } from "./components/Inbox";
import { Toolbar } from "./components/Toolbar";
import { useElementWidth } from "./hooks";
import { comboLabel, matches, shortcutLabel, type Command } from "./commands";
import { ShortcutHints } from "./components/ShortcutHints";
import { runOnce, useNativeMenu } from "./nativeMenu";
import { closeSettingsWindow, EV as SETTINGS_EV, openSettingsWindow, SETTINGS_LABEL, useSettingsWindow, type SettingsData } from "./settingsWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { inTauri } from "./mock";
import type { PaletteItem } from "./components/CommandPalette";
import type { OwnerRow, RepoRow } from "./components/FilterDialog";
import { FILTER_GROUPS, NO_FILTERS, type Filters, type SortKey } from "./inboxFilters";
import { ReviewStatus } from "./components/ReviewStatus";
import { compileGlobs, filePath, ignoreWhitespace } from "./diffUtils";
import { fileIcon, SEVERITY } from "./icons";
import { emptySession, flushSessions, useSessions, useStoredState, type ChatItem } from "./sessions";
import type { SettingsSection } from "./components/Settings";
import { applyTheme, applyZoom } from "./platform";
import { ownerVisible, stepZoom, useSettings } from "./settings";
import { useUpdater } from "./updates";
import { LruCache, readInboxCache, writeInboxCache } from "./cache";
import { waitingSince } from "./risk";
import { notify, useReviewNotifications } from "./notify";
import { bucket, minutes, track } from "./telemetry";

interface Loaded {
  key: string;
  details: PrDetails;
  bodyHtml: string;
  files: FileData[];
  /** The raw diff, to keep the parsed files (and their highlighting) when a refresh finds no change. */
  diff: string;
  issues: LinkedIssue[];
  threads: ReviewThread[];
}

/** Recently opened or prefetched PRs; opening one shows this copy while GitHub is asked again. */
const prCache = new LruCache<Loaded>(25);
const inflight = new Map<string, Promise<{ details: PrDetails; diff: string }>>();

/** Details and diff for a PR, sharing a request already in flight (from a hover, say). */
function fetchCore(pr: ReviewRequest) {
  const k = prKey(pr);
  let req = inflight.get(k);
  if (!req) {
    const repo = pr.repository.nameWithOwner;
    req = Promise.all([api.prDetails(repo, pr.number), api.prDiff(repo, pr.number)])
      .then(([details, diff]) => ({ details, diff }))
      .finally(() => inflight.delete(k));
    inflight.set(k, req);
  }
  return req;
}

/** Starts loading a PR the user is likely to open next. */
function prefetchPr(pr: ReviewRequest) {
  const k = prKey(pr);
  if (prCache.get(k) || inflight.has(k)) return;
  fetchCore(pr)
    .then(({ details, diff }) => {
      if (!prCache.get(k)) prCache.set(k, { key: k, details, diff, files: parseDiff(diff, { nearbySequences: "zip" }), bodyHtml: "", issues: [], threads: [] });
    })
    .catch(() => {});
}

type Pane = "inbox" | "outline" | "content";
const PANES: Pane[] = ["inbox", "outline", "content"];
const paneEl = (p: Pane) => document.querySelector<HTMLElement>(`[data-pane="${p}"]`);
const navItems = (p: Pane) => [...(paneEl(p)?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
const isCurrent = (el: HTMLElement) => el.matches(".sel, .cur, [aria-current='true']");

/** Your last review of a PR and, once loaded, what changed after it. */
interface SinceReview {
  review: LastReview | null;
  commits?: { oid: string; subject: string }[];
  files?: FileData[];
  loading?: boolean;
  error?: string;
}

const REVIEW_VERB: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "reviewed" };

function ago(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

type ClaudeUsage = Pick<ClaudeEvent, "usage" | "total_cost_usd">;
/** Opens the worktree, or a file and line in it, in VS Code. */
function openInVsCode(worktree: string, path?: string, line?: number) {
  const full = `${worktree}${path ? `/${path}` : ""}`.replace(/\\/g, "/").replace(/^\/*/, "/");
  openUrl(`vscode://file${encodeURI(full)}${line ? `:${line}` : ""}`).catch((e) => console.error("Could not open VS Code", e));
}

const tokensOf = (e: ClaudeUsage) =>
  (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0);

export default function App() {
  // The last inbox shows at once; a refresh from GitHub replaces it.
  const [inboxCache] = useState(readInboxCache);
  const [requests, setRequests] = useState<ReviewRequest[] | null>(inboxCache?.requests ?? null);
  const [myPrs, setMyPrs] = useState<ReviewRequest[] | null>(inboxCache?.myPrs ?? null);
  /** Set once GitHub answered in this run, so automatic work never starts from the cached copy. */
  const [inboxLive, setInboxLive] = useState(false);
  const [inboxView, setInboxView] = useStoredState<InboxView>("better-lgtm.inboxView", "review");
  const [inboxSort, setInboxSort] = useStoredState<SortKey>("better-lgtm.inboxSort", "risk");
  const [storedFilters, setInboxFilters] = useStoredState<Filters>("better-lgtm.inboxFilters", NO_FILTERS);
  const inboxFilters = { ...NO_FILTERS, ...storedFilters };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(inboxCache?.syncedAt ?? null);
  const [settings, updateSettings] = useSettings();
  const generatedGlobs = useMemo(() => compileGlobs(settings.generatedPatterns), [settings.generatedPatterns]);
  const hideRules = useMemo(
    () => ({ generated: settings.hideGenerated, tests: settings.hideTests, globs: generatedGlobs }),
    [settings.hideGenerated, settings.hideTests, generatedGlobs],
  );
  const agent = harnessOf(settings).short;
  const updater = useUpdater(settings.autoUpdate);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [infoDialog, setInfoDialog] = useState<"shortcuts" | "about" | null>(null);
  /** The version whose release notes are open in What's new. */
  const [whatsNew, setWhatsNew] = useState<string | null>(null);
  /** Held until onboarding is out of the way, so the notes never cover the first-run screens. */
  const [announce, setAnnounce] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [recheckRuns, setRecheckRuns] = useState<Record<string, { running: boolean; error?: string }>>({});
  const [sinceReviews, setSinceReviews] = useState<Record<string, SinceReview>>({});
  /** Diff tab: the whole PR, or only what changed since your last review. */
  const [diffRange, setDiffRange] = useState<"all" | "since">("all");
  /** The last review posted from the app, per PR, so the status bar can link to it. */
  const [postedReviews, setPostedReviews] = useState<Record<string, string>>({});
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [orgs, setOrgs] = useState<{ login: string; orgs: string[] } | null>(inboxCache?.orgs ?? null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [configReady, setConfigReady] = useState(false);
  /** Whether gh, claude and git are installed and signed in. Null until the first check answers. */
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [toolChecking, setToolChecking] = useState(false);
  /** The setup screen was left with problems still open ("Continue anyway"); it stays away until asked for. */
  const [setupSkipped, setSetupSkipped] = useState(false);
  /** The setup screen was asked for from the Help menu. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Where a first run is: the tools, then the Claude Code that was found, then what the inbox shows. */
  const [firstStep, setFirstStep] = useState<"tools" | "agent" | "choices">("tools");
  /** Showing the built-in sample pull requests instead of GitHub's. */
  const [sample, setSample] = useState(false);
  const sampleSelect = useRef(false);
  const [inboxOpen, setInboxOpen] = useStoredState("better-lgtm.inboxOpen", true);
  const [chatOpen, setChatOpen] = useStoredState("better-lgtm.chatOpen", true);
  const split = settings.diffLayout === "split";
  const setSplit = (v: boolean) => updateSettings({ diffLayout: v ? "split" : "unified" });
  const diffMode = settings.diffMode;
  const setDiffMode = (m: DiffMode) => updateSettings({ diffMode: m });
  const [guideStep, setGuideStep] = useState(0);
  /** The guided review section in view, for the chat. Not `walkthrough[guideStep]`: the review leaves out empty steps. */
  const [guideTopic, setGuideTopic] = useState<WalkStep | undefined>();
  const [guideRuns, setGuideRuns] = useState<Record<string, { running: boolean; error?: string }>>({});
  // Below this width the inbox sits collapsed as a strip unless the user expands it.
  const [appRef, appWidth] = useElementWidth<HTMLDivElement>();
  const compact = appWidth > 0 && appWidth < 1100;
  const [inboxExpanded, setInboxExpanded] = useState(false);

  const [selected, setSelected] = useState<ReviewRequest | null>(null);
  // With nothing selected the inbox is the whole point of the screen, so it never collapses then.
  const inboxMode = !inboxOpen ? "hidden" : compact && !inboxExpanded && selected ? "rail" : "full";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"analysis" | "diff">("analysis");
  const [focusPane, setFocusPane] = useState<Pane>("inbox");
  const [outlineKey, setOutlineKey] = useState<OutlineKey>("s0");
  const [diffTarget, setDiffTarget] = useState<{ path: string | null; range: Anchor | null; finding: number | null }>({ path: null, range: null, finding: null });

  const { sessions, update, remove: removeSessions, clearAll, ready: sessionsReady } = useSessions();
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [chatRunning, setChatRunning] = useState<Record<string, boolean>>({});
  const [chatFocus, setChatFocus] = useState(0);
  const runIds = useRef<Record<string, string>>({});

  const key = selected ? prKey(selected) : null;
  const session = key ? sessions[key] ?? emptySession() : null;
  const analysis = session?.analysis;

  useEffect(preloadViews, []);
  // Checked once per launch, against the settings as they were when the app opened.
  useEffect(() => {
    versionToAnnounce(settings.onboarded).then(setAnnounce).catch(() => {});
    appVersion().then(setCurrentVersion).catch(() => {});
  }, []);
  useEffect(() => track("app_opened", { harness: settings.harness, auto_analyze: settings.autoAnalyze, onboarded: settings.onboarded }), []);

  // The backend needs tool paths, the data folder and Claude options before it runs anything.
  useEffect(() => {
    api
      .setConfig({
        ghPath: settings.ghPath,
        claudePath: settings.claudePath,
        harness: settings.harness,
        codexPath: settings.codexPath,
        geminiPath: settings.geminiPath,
        copilotPath: settings.copilotPath,
        dataDir: settings.dataDir,
        model: settings.model,
        effort: settings.effort,
      })
      .then(() => setConfigReady(true))
      .catch(() => setConfigReady(true));
  }, [settings.ghPath, settings.claudePath, settings.harness, settings.codexPath, settings.geminiPath, settings.copilotPath, settings.dataDir, settings.model, settings.effort]);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => applyZoom(settings.zoom), [settings.zoom]);

  const reloadOrgs = useCallback(() => {
    setOrgsError(null);
    const mode = isSampleMode();
    api
      .listOrgs()
      .then((o) => {
        // An answer from before the sample was entered or left belongs to the other inbox.
        if (mode !== isSampleMode()) return;
        setOrgs(o);
        if (!mode) writeInboxCache({ orgs: o });
      })
      .catch((e) => mode === isSampleMode() && setOrgsError(errorText(e)));
  }, []);
  useEffect(() => {
    if (configReady) reloadOrgs();
  }, [configReady, settings.ghPath, reloadOrgs]);

  const refresh = useCallback(async () => {
    setInboxLoading(true);
    const mode = isSampleMode();
    try {
      const [review, mine] = await Promise.all([api.listReviewRequests(settings.includeTeams), api.listMyPrs()]);
      if (mode !== isSampleMode()) return;
      setRequests(review);
      setMyPrs(mine);
      setInboxError(null);
      setInboxLive(true);
      const now = Date.now();
      setSyncedAt(now);
      // The sample never replaces the saved copy of the real inbox.
      if (!mode) writeInboxCache({ requests: review, myPrs: mine, syncedAt: now });
    } catch (e) {
      if (mode === isSampleMode()) setInboxError(errorText(e));
    } finally {
      setInboxLoading(false);
    }
  }, [settings.includeTeams, settings.ghPath]);

  useEffect(() => {
    if (!configReady) return;
    refresh();
    const t = setInterval(refresh, settings.refreshMinutes * 60 * 1000);
    return () => clearInterval(t);
  }, [refresh, configReady, settings.refreshMinutes]);

  // Setup: are the tools installed and signed in? Checked at start, when a tool path changes, and when the inbox fails.
  const checkTools = useCallback(() => {
    setToolChecking(true);
    api
      .toolStatus()
      .then(setToolStatus)
      .catch((e) => setToolStatus({ ghError: errorText(e), agentError: errorText(e), gitError: errorText(e), dataDir: "" }))
      .finally(() => setToolChecking(false));
  }, []);
  useEffect(() => {
    if (configReady) checkTools();
  }, [configReady, settings.ghPath, settings.claudePath, settings.harness, settings.codexPath, settings.geminiPath, settings.copilotPath, checkTools]);
  useEffect(() => {
    if (inboxError && !isSampleMode()) checkTools();
  }, [inboxError, checkTools]);
  const setupIsBroken = !!toolStatus && setupBroken(toolStatus);
  // Once a problem is fixed, load what couldn't load before.
  const wasBroken = useRef(false);
  useEffect(() => {
    if (wasBroken.current && !setupIsBroken && !isSampleMode()) {
      reloadOrgs();
      refresh();
    }
    wasBroken.current = setupIsBroken;
  }, [setupIsBroken]);
  /** Which onboarding screen replaces the inbox and review, if any. New users see it while the first check runs. */
  const onboarding: "tools" | "agent" | "choices" | null = sample
    ? null
    : (setupIsBroken && !setupSkipped) || setupOpen
      ? "tools"
      : !settings.onboarded
        ? firstStep
        : null;
  // Show What's new once nothing else is taking over the window.
  useEffect(() => {
    if (announce && !onboarding) {
      setWhatsNew(announce);
      setAnnounce(null);
    }
  }, [announce, onboarding]);

  // Shortcuts come from the command list (menus and palette use the same list); Escape closes Settings.
  const commandsRef = useRef<Command[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsOpen && !paletteOpen && !infoDialog) {
        setSettingsOpen(false);
        return;
      }
      const t = e.target;
      const typing = t instanceof Element && !!t.closest("input, textarea, select");
      for (const c of commandsRef.current) {
        if (c.enabled === false) continue;
        // While typing, only ⌘/Ctrl shortcuts and function keys apply, so letters still reach the field.
        const hit = [c.keys, ...(c.altKeys ?? [])].find((k) => k && matches(e, k) && (!typing || k.ctrl || /^F\d+$/.test(k.key)));
        if (hit) {
          e.preventDefault();
          runOnce(c);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, paletteOpen, infoDialog]);

  /** PRs that pass the organization and draft settings. */
  const visibleOf = useCallback(
    (list: ReviewRequest[] | null) =>
      list?.filter(
        (r) =>
          // The sample's organizations aren't yours, so your organization choices don't apply to it.
          sample ||
          ((settings.showDrafts || !r.isDraft) &&
          ownerVisible(settings, r.repository.nameWithOwner.split("/")[0], orgs?.orgs ?? null) &&
            !settings.hiddenRepos.includes(r.repository.nameWithOwner)),
      ) ?? null,
    [settings, orgs, sample],
  );
  const visibleRequests = useMemo(() => visibleOf(requests), [visibleOf, requests]);
  const visibleMine = useMemo(() => visibleOf(myPrs), [visibleOf, myPrs]);
  const inboxList = inboxView === "mine" ? visibleMine : visibleRequests;
  // Sample pull requests aren't review requests: no notifications, no count on the app icon.
  useReviewNotifications(sample ? null : visibleRequests, settings.notifications);
  const hiddenCount = inboxView === "mine" ? (myPrs?.length ?? 0) - (visibleMine?.length ?? 0) : (requests?.length ?? 0) - (visibleRequests?.length ?? 0);
  /** The inbox's "hide" button: drops an organization, or personal repositories, from the inbox. */
  /** Shows or hides an organization (or personal repositories) in the inbox, following the organization mode. */
  const setOwnerVisible = (owner: string, show: boolean) => {
    if (orgs && !orgs.orgs.includes(owner)) updateSettings({ includePersonal: show });
    else if (settings.orgMode === "all")
      updateSettings({ hiddenOrgs: show ? settings.hiddenOrgs.filter((o) => o !== owner) : [...new Set([...settings.hiddenOrgs, owner])] });
    else updateSettings({ selectedOrgs: show ? [...new Set([...settings.selectedOrgs, owner])] : settings.selectedOrgs.filter((o) => o !== owner) });
  };
  const hideOwner = (owner: string) => setOwnerVisible(owner, false);
  const setRepoVisible = (repo: string, show: boolean) =>
    updateSettings({ hiddenRepos: show ? settings.hiddenRepos.filter((r) => r !== repo) : [...new Set([...settings.hiddenRepos, repo])] });

  // Every owner and repository with an open PR in either list, for the filter dialog.
  const allPrs = useMemo(() => [...(requests ?? []), ...(myPrs ?? [])], [requests, myPrs]);
  const ownerRows: OwnerRow[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of allPrs) {
      const owner = pr.repository.nameWithOwner.split("/")[0];
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count, visible: ownerVisible(settings, name, orgs?.orgs ?? null), personal: !!orgs && !orgs.orgs.includes(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allPrs, settings, orgs]);
  const repoRows: RepoRow[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of allPrs) counts.set(pr.repository.nameWithOwner, (counts.get(pr.repository.nameWithOwner) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count, visible: !settings.hiddenRepos.includes(name) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allPrs, settings.hiddenRepos]);
  const activeFilters = FILTER_GROUPS.filter((g) => inboxFilters[g.key] !== "any").length + (settings.showDrafts ? 0 : 1) + (settings.hiddenRepos.length ? 1 : 0);
  const clearFilters = () => {
    setInboxFilters(NO_FILTERS);
    updateSettings({ showDrafts: true, hiddenRepos: [] });
  };
  const openSettings = (section: SettingsSection) => {
    if (useSettingsWindow) return void openSettingsWindow(section);
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  // Load PR details and diff when the selection changes. A cached copy shows at once; the details
  // and diff come next, and the description, linked issues and conversations fill in after.
  useEffect(() => {
    if (!selected || !key) return;
    let stale = false;
    setLoadError(null);
    const repo = selected.repository.nameWithOwner;
    const cached = prCache.get(key);
    if (cached) setLoaded(cached);
    let extras: Pick<Loaded, "bodyHtml" | "issues" | "threads"> | null = null;
    const merge = (patch: Partial<Loaded>) =>
      setLoaded((l) => (l && l.key === key ? { ...l, ...patch } : l));
    fetchCore(selected)
      .then(({ details, diff }) => {
        if (stale) return;
        setLoaded((l) => {
          const prev = l && l.key === key ? l : prCache.get(key);
          const files = prev && prev.diff === diff ? prev.files : parseDiff(diff, { nearbySequences: "zip" });
          return { key, bodyHtml: "", issues: [], threads: [], ...prev, ...extras, details, diff, files };
        });
      })
      .catch((e) => !stale && !cached && setLoadError(errorText(e)));
    Promise.all([
      // The rendered description is a nicety; fall back to the raw Markdown if it fails.
      api.prBodyHtml(repo, selected.number).catch(() => cached?.bodyHtml ?? ""),
      api.linkedIssues(repo, selected.number).catch(() => cached?.issues ?? ([] as LinkedIssue[])),
      api.reviewThreads(repo, selected.number).catch(() => cached?.threads ?? ([] as ReviewThread[])),
    ]).then(([bodyHtml, issues, threads]) => {
      if (stale) return;
      extras = { bodyHtml, issues, threads };
      merge(extras);
    });
    return () => {
      stale = true;
    };
  }, [selected, key]);
  useEffect(() => {
    if (loaded) prCache.set(loaded.key, loaded);
  }, [loaded]);

  const setRun = (k: string, fn: (r: RunState) => RunState) =>
    setRuns((all) => ({ ...all, [k]: fn(all[k] ?? { running: false, step: "", log: [] }) }));

  const ensureWorktree = async (k: string, pr: ReviewRequest, details: PrDetails) => {
    const existing = sessions[k]?.worktree;
    if (existing && sessions[k]?.headOid === details.headRefOid) return existing;
    const wt = await api.prepareWorktree(pr.repository.nameWithOwner, pr.number, details.baseRefName);
    update(k, (s) => ({ ...s, worktree: wt, headOid: details.headRefOid }));
    return wt;
  };

  /** Groups the PR's changes into guided review steps, continuing the analysis session. Returns whether it worked. */
  const createWalkthrough = async (k: string, wt: string, session: string, maxBudgetUsd?: number, analyzed?: Analysis) => {
    setGuideRuns((g) => ({ ...g, [k]: { running: true } }));
    try {
      let answer: unknown = "";
      let sessionId = session;
      let usage: ClaudeUsage = {};
      // Predict-first questions avoid what the findings and risks already say, so they don't quiz what was just read.
      const flagged = analyzed ?? sessions[k]?.analysis;
      const probes = settings.predictFirst ? { avoid: [...(flagged?.findings ?? []).map((f) => f.title), ...(flagged?.risks ?? []).map((r) => `${r.area}: ${r.why}`)] } : undefined;
      await api.claudeRun(`guide-${k}-${Date.now()}`, wt, buildWalkthroughPrompt(settings.generatedPatterns, probes), session, (e) => {
        if (e.type === "result") {
          answer = answerOf(e);
          sessionId = e.session_id ?? sessionId;
          usage = e;
        }
      }, { schema: probes ? WALKTHROUGH_SCHEMA_PROBES : WALKTHROUGH_SCHEMA, maxBudgetUsd });
      const steps = parseWalkthrough(answer);
      if (!steps) throw new Error(`${agent}'s answer didn't contain review steps. Try again.`);
      update(k, (x) => ({
        ...x,
        sessionId,
        analysis: x.analysis ? { ...x.analysis, walkthrough: steps } : x.analysis,
        probeAnswers: keepAnswers(x.probeAnswers, steps),
        tokens: (x.tokens ?? 0) + tokensOf(usage),
        costUsd: (x.costUsd ?? 0) + (usage.total_cost_usd ?? 0),
      }));
      setGuideRuns((g) => ({ ...g, [k]: { running: false } }));
      track("walkthrough_ready", { harness: settings.harness, sections: bucket(steps.length) });
      return true;
    } catch (e) {
      setGuideRuns((g) => ({ ...g, [k]: { running: false, error: errorText(e) } }));
      return false;
    }
  };

  /**
   * Analyzes one PR: the analysis, a second pass that tries to disprove its findings, then the guided
   * review in the background. Background runs (auto-analyze) leave the current view alone and notify when done.
   */
  const runAnalysis = async (k: string, pr: ReviewRequest, details: PrDetails, opts: { since?: string; background?: boolean } = {}) => {
    const runId = `analysis-${k}-${Date.now()}`;
    runIds.current[k] = runId;
    setRun(k, () => ({ running: true, step: "Preparing the worktree…", log: [] }));
    // Automatic runs share one spending limit across the analysis, the double-check and the guided review.
    const budget = opts.background && settings.autoAnalyzeBudgetUsd > 0 ? settings.autoAnalyzeBudgetUsd : undefined;
    let tokens = 0;
    let cost = 0;
    let overBudget = false;
    const started = Date.now();
    const left = () => (budget === undefined ? undefined : Math.max(budget - cost, 0));
    const logTools = (e: ClaudeEvent) => {
      if (e.type === "result" && e.subtype === "error_max_budget_usd") overBudget = true;
      if (e.type !== "assistant") return;
      for (const block of e.message?.content ?? []) {
        if (block.type === "tool_use" && block.name !== "StructuredOutput") {
          const line = describeToolUse(block.name ?? "", block.input);
          setRun(k, (r) => ({ ...r, step: line, log: [...r.log, line] }));
        }
      }
    };
    try {
      const wt = await ensureWorktree(k, pr, details);
      const [issues, threads] = await Promise.all([
        api.linkedIssues(pr.repository.nameWithOwner, pr.number).catch(() => [] as LinkedIssue[]),
        api.reviewThreads(pr.repository.nameWithOwner, pr.number).catch(() => [] as ReviewThread[]),
      ]);
      setRun(k, (r) => ({ ...r, step: `${agent} is reading the change…`, log: [...r.log, `Worktree: ${wt}`, ...issues.map((i) => `Linked issue #${i.number}: ${i.title}`)] }));
      // What the reviewer already did with findings: on this PR's last analysis, and on the repository's other PRs.
      const before = sessions[k];
      const earlier: EarlierFinding[] = (before?.analysis?.findings ?? []).map((finding) => ({ finding, state: before?.findingStates?.[findingId(finding)] }));
      // Finding ids are "path|title" (see findingId), so the file comes back out of the id.
      const dismissedInRepo: RepoDismissal[] = Object.entries(sessions)
        .filter(([other]) => other !== k && other.startsWith(`${pr.repository.nameWithOwner}#`))
        .flatMap(([other, s]) => Object.entries(s.findingStates ?? {}).map(([id, st]) => ({ other, id, st })))
        .filter(({ st }) => st.state === "dismissed")
        .sort((x, y) => y.st.at - x.st.at)
        .slice(0, 12)
        .map(({ other, id, st }) => {
          const bar = id.indexOf("|");
          return { title: id.slice(bar + 1), path: bar > 0 ? id.slice(0, bar) : undefined, reason: st.reason, pr: other.slice(other.lastIndexOf("#")) };
        });
      if (dismissedInRepo.length) {
        const line = `Using ${dismissedInRepo.length === 1 ? "1 dismissal" : `${dismissedInRepo.length} dismissals`} from other pull requests in this repository`;
        setRun(k, (r) => ({ ...r, log: [...r.log, line, ...dismissedInRepo.map((d) => `  ${d.pr}: ${d.title}${d.path ? ` (${d.path})` : ""}`)] }));
      }
      const prompt = buildAnalysisPrompt(details, {
        instructions: [settings.reviewInstructions, settings.repoInstructions[pr.repository.nameWithOwner] ?? ""].filter((x) => x.trim()).join("\n"),
        since: opts.since,
        generatedPatterns: settings.generatedPatterns,
        issues,
        threads,
        selfReview: !!orgs?.login && details.author.login === orgs.login,
        earlier,
        dismissedInRepo,
      });
      let answer: unknown = "";
      let finalText = "";
      let sessionId: string | undefined;
      await api.claudeRun(runId, wt, prompt, undefined, (e) => {
        if (e.session_id) sessionId = e.session_id;
        logTools(e);
        if (e.type === "result") {
          answer = answerOf(e);
          finalText = e.result ?? "";
          tokens += tokensOf(e);
          cost += e.total_cost_usd ?? 0;
        }
      }, { schema: ANALYSIS_SCHEMA, maxBudgetUsd: budget });
      let parsed = parseAnalysis(answer);
      if (parsed) parsed = { ...carryFindingIds(parsed, earlier.map((x) => x.finding)), repoDismissals: dismissedInRepo.length ? dismissedInRepo : undefined };

      // Second pass, in a fresh session so it doesn't inherit the analysis's reasoning. If it fails, the findings stay as they are.
      const toCheck = parsed ? parsed.findings.flatMap((f, i) => (worthVerifying(f) ? [i] : [])) : [];
      const claimCount = parsed?.claims.length ?? 0;
      if (parsed && settings.verifyFindings && (toCheck.length || claimCount) && left() !== 0) {
        const what = [toCheck.length && (toCheck.length === 1 ? "1 finding" : `${toCheck.length} findings`), claimCount && (claimCount === 1 ? "1 claim" : `${claimCount} claims`)].filter(Boolean).join(" and ");
        setRun(k, (r) => ({ ...r, step: "Double-checking the findings…", log: [...r.log, `Double-checking ${what}`] }));
        const verifyId = `verify-${k}-${Date.now()}`;
        runIds.current[k] = verifyId;
        try {
          let verdicts: unknown = "";
          await api.claudeRun(verifyId, wt, buildVerifyPrompt(details, parsed, toCheck), undefined, (e) => {
            logTools(e);
            if (e.type === "result") {
              verdicts = answerOf(e);
              tokens += tokensOf(e);
              cost += e.total_cost_usd ?? 0;
            }
          }, { schema: VERIFY_SCHEMA, maxBudgetUsd: left() });
          const verified = parseVerify(verdicts);
          if (verified) {
            parsed = applyVerification(parsed, verified);
            const changed = parsed.claims.filter((c) => c.check?.status === "changed").length;
            if (changed) setRun(k, (r) => ({ ...r, log: [...r.log, `The double-check changed ${changed === 1 ? "1 claim verdict" : `${changed} claim verdicts`}`] }));
          } else setRun(k, (r) => ({ ...r, log: [...r.log, "The double-check gave no readable result; the findings and claims are unchanged."] }));
        } catch (e) {
          setRun(k, (r) => ({ ...r, log: [...r.log, `Couldn't double-check the findings: ${errorText(e)}`] }));
        }
      }

      update(k, (s) => ({
        ...s,
        sessionId,
        analysis: parsed ?? s.analysis,
        analysisRaw: parsed ? undefined : finalText,
        analyzedAt: parsed ? Date.now() : s.analyzedAt,
        analysisSince: parsed ? opts.since : s.analysisSince,
        analysisHead: parsed ? details.headRefOid : s.analysisHead,
        findingChecks: parsed ? undefined : s.findingChecks,
        // Picks are positions in the old list of findings, which a new analysis replaces.
        inReview: parsed ? [] : s.inReview,
        tokens: (s.tokens ?? 0) + tokens,
        costUsd: (s.costUsd ?? 0) + cost,
      }));
      if (parsed && !opts.background) {
        setGuideStep(0); setGuideTopic(undefined);
        setOutlineKey("s0");
        setFocusPane("outline");
      }
      if (parsed && opts.background && settings.notifications) {
        const crit = parsed.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
        notify(`Analysis ready: ${pr.repository.name}#${pr.number}`, `${pr.title}\n${crit ? `${crit} critical or high ${crit === 1 ? "finding" : "findings"}` : `${parsed.findings.length} findings, none critical or high`}`).catch(() => {});
      }
      setRun(k, (r) => ({ ...r, running: false, step: "", error: parsed ? undefined : `${agent} finished, but its answer didn't contain a readable result.` }));
      track(parsed ? "analysis_finished" : "analysis_failed", {
        harness: settings.harness,
        background: !!opts.background,
        since_last_review: !!opts.since,
        verified: settings.verifyFindings,
        decision: parsed?.recommendation?.decision,
        high_findings: parsed ? bucket(parsed.findings.filter((f) => f.severity === "critical" || f.severity === "high").length) : undefined,
        findings: parsed ? bucket(parsed.findings.length) : undefined,
        duration_min: minutes(Date.now() - started),
        reason: parsed ? undefined : "unreadable",
      });
      // The verdict is on screen; the guided review follows on its own.
      if (parsed && !parsed.walkthrough && sessionId && left() !== 0) void createWalkthrough(k, wt, sessionId, left(), parsed);
    } catch (e) {
      const error = overBudget
        ? `Stopped at the $${budget} limit for automatic analyses. Start the review yourself, or raise the limit in Settings › Agent.`
        : errorText(e);
      setRun(k, (r) => ({ ...r, running: false, error }));
      track("analysis_failed", { harness: settings.harness, background: !!opts.background, reason: overBudget ? "budget" : "error", duration_min: minutes(Date.now() - started) });
    }
  };
  const startAnalysis = async (opts: { since?: string } = {}) => {
    if (!selected || !loaded || loaded.key !== key || !key) return;
    await runAnalysis(key, selected, loaded.details, opts);
  };

  const cancelAnalysis = () => key && runIds.current[key] && api.claudeCancel(runIds.current[key]);

  const sendChat = async (text: string, context: ChatContext | null) => {
    if (!selected || !loaded || loaded.key !== key || !key) return;
    const k = key;
    const push = (item: ChatItem) => update(k, (s) => ({ ...s, chat: [...s.chat, item] }));
    push({ role: "user", text, context: context?.label });
    const prompt = context ? `${context.prompt}\n\n${text}` : text;
    setChatRunning((c) => ({ ...c, [k]: true }));
    track("chat_sent", { harness: settings.harness, with_context: !!context });
    const runId = `chat-${k}-${Date.now()}`;
    runIds.current[`chat-${k}`] = runId;
    try {
      const wt = await ensureWorktree(k, selected, loaded.details);
      await api.claudeRun(runId, wt, prompt, sessions[k]?.sessionId, (e) => {
        if (e.type === "assistant") {
          for (const block of e.message?.content ?? []) {
            if (block.type === "tool_use") push({ role: "tool", text: describeToolUse(block.name ?? "", block.input) });
            if (block.type === "text" && block.text?.trim()) push({ role: "assistant", text: block.text.trim() });
          }
        }
        if (e.type === "result") {
          update(k, (s) => ({
            ...s,
            sessionId: e.session_id ?? s.sessionId,
            tokens: (s.tokens ?? 0) + tokensOf(e),
            costUsd: (s.costUsd ?? 0) + (e.total_cost_usd ?? 0),
          }));
        }
      }, { chat: true });
    } catch (e) {
      push({ role: "error", text: errorText(e) });
    } finally {
      setChatRunning((c) => ({ ...c, [k]: false }));
    }
  };

  const selectPr = (pr: ReviewRequest) => {
    setSelected(pr);
    setFocusPane("inbox");
    setTab("analysis");
    setDiffTarget({ path: null, range: null, finding: null });
    setOutlineKey("s0");
    setGuideStep(0); setGuideTopic(undefined);
  };

  /** Swaps the inbox between GitHub and the built-in sample, starting from an empty list either way. */
  const switchInbox = (toSample: boolean) => {
    if (toSample) track("sample_opened");
    setSampleMode(toSample);
    setSample(toSample);
    setSelected(null);
    setRequests(null);
    setMyPrs(null);
    setOrgs(null);
    setInboxError(null);
    setInboxLive(false);
    setInboxView("review");
    setSettingsOpen(false);
    setSetupOpen(false);
    reloadOrgs();
    refresh();
  };
  /** Shows the sample pull requests and opens the first one. Needs no tools: nothing reaches GitHub or Claude. */
  const enterSample = () => {
    sampleSelect.current = true;
    switchInbox(true);
  };
  const leaveSample = () => {
    // The sample's reviews aren't worth keeping, and its next visit should start clean.
    removeSessions([...(requests ?? []), ...(myPrs ?? [])].map(prKey));
    switchInbox(false);
    checkTools();
  };
  useEffect(() => {
    if (!sample || !sampleSelect.current || !requests?.length) return;
    sampleSelect.current = false;
    selectPr(requests[0]);
  }, [sample, requests]);

  const openAnchor = (a: Anchor, finding: number | null) => {
    setDiffTarget({ path: a.path, range: a, finding });
    setDiffMode("files");
    setTab("diff");
  };

  /** Creates the guided review on request: for older analyses, or when the automatic one failed. */
  const generateWalkthrough = async () => {
    const s = key ? sessions[key] : undefined;
    if (!key || !s?.worktree || !s.sessionId) return;
    if (await createWalkthrough(key, s.worktree, s.sessionId)) setGuideStep(0); setGuideTopic(undefined);
  };

  /** Claude drafts the overall review summary, continuing the PR's session so it knows the change. */
  const draftSummary = async (event: string, comments: Finding[], notes: string) => {
    const s = key ? sessions[key] : undefined;
    if (!key || !s?.worktree) throw new Error(`Start the review first, so ${agent} has the code.`);
    const k = key;
    let text = "";
    let sessionId = s.sessionId;
    let usage: ClaudeUsage = {};
    await api.claudeRun(`summary-${k}-${Date.now()}`, s.worktree, buildSummaryPrompt(event, comments, notes), s.sessionId, (e) => {
      if (e.type === "result") {
        text = e.result ?? "";
        sessionId = e.session_id ?? sessionId;
        usage = e;
      }
    });
    update(k, (x) => ({ ...x, sessionId, tokens: (x.tokens ?? 0) + tokensOf(usage), costUsd: (x.costUsd ?? 0) + (usage.total_cost_usd ?? 0) }));
    if (!text.trim()) throw new Error(`${agent} didn't return a summary. Try again.`);
    return text.trim();
  };

  /** Claude drafts the description of your own PR in its worktree. */
  const draftDescription = async () => {
    if (!key || !selected || !loaded || loaded.key !== key) throw new Error("Open the pull request first.");
    const k = key;
    const wt = await ensureWorktree(k, selected, loaded.details);
    let text = "";
    let usage: ClaudeUsage = {};
    await api.claudeRun(`describe-${k}-${Date.now()}`, wt, buildDescriptionPrompt(loaded.details), sessions[k]?.sessionId, (e) => {
      if (e.type === "result") {
        text = e.result ?? "";
        usage = e;
      }
    });
    update(k, (x) => ({ ...x, tokens: (x.tokens ?? 0) + tokensOf(usage), costUsd: (x.costUsd ?? 0) + (usage.total_cost_usd ?? 0) }));
    if (!text.trim()) throw new Error(`${agent} didn't return a description. Try again.`);
    track("description_drafted", { harness: settings.harness });
    return text.trim();
  };
  const saveDescription = async (body: string) => {
    if (!key || !selected) return;
    const k = key;
    const repo = selected.repository.nameWithOwner;
    await api.updatePrBody(repo, selected.number, body);
    const [details, bodyHtml] = await Promise.all([api.prDetails(repo, selected.number), api.prBodyHtml(repo, selected.number).catch(() => "")]);
    setLoaded((l) => (l && l.key === k ? { ...l, details, bodyHtml } : l));
  };

  const reloadThreads = async () => {
    if (!key || !selected) return;
    const k = key;
    const threads = await api.reviewThreads(selected.repository.nameWithOwner, selected.number);
    setLoaded((l) => (l && l.key === k ? { ...l, threads } : l));
  };
  /** Claude drafts your reply to a review conversation, reading the code it's about. */
  const draftReply = async (t: ReviewThread) => {
    if (!key || !selected || !loaded || loaded.key !== key) throw new Error("Open the pull request first.");
    const k = key;
    const wt = await ensureWorktree(k, selected, loaded.details);
    let text = "";
    let usage: ClaudeUsage = {};
    await api.claudeRun(`reply-${k}-${Date.now()}`, wt, buildReplyPrompt(t, orgs?.login ?? "me", loaded.details.author.login), sessions[k]?.sessionId, (e) => {
      if (e.type === "result") {
        text = e.result ?? "";
        usage = e;
      }
    });
    update(k, (x) => ({ ...x, tokens: (x.tokens ?? 0) + tokensOf(usage), costUsd: (x.costUsd ?? 0) + (usage.total_cost_usd ?? 0) }));
    if (!text.trim()) throw new Error(`${agent} didn't return a reply. Try again.`);
    track("reply_drafted", { harness: settings.harness });
    return text.trim();
  };
  const replyToThread = async (t: ReviewThread, body: string) => {
    if (!selected || !t.comments[0]) return;
    await api.replyToThread(selected.repository.nameWithOwner, selected.number, t.comments[0].id, body);
    await reloadThreads();
  };
  const resolveThread = async (t: ReviewThread, resolve: boolean) => {
    await api.resolveThread(t.id, resolve);
    await reloadThreads();
  };

  /** After new commits, asks Claude which of the existing findings are fixed. */
  const recheckFindings = async () => {
    const s = key ? sessions[key] : undefined;
    const from = s?.analysisHead ?? s?.headOid;
    if (!key || !selected || !loaded || loaded.key !== key || !s?.analysis?.findings.length || !from) return;
    const k = key;
    const details = loaded.details;
    const findings = s.analysis.findings;
    setRecheckRuns((r) => ({ ...r, [k]: { running: true } }));
    try {
      const wt = await ensureWorktree(k, selected, details);
      let answer: unknown = "";
      let sessionId = s.sessionId;
      let usage: ClaudeUsage = {};
      await api.claudeRun(`recheck-${k}-${Date.now()}`, wt, buildRecheckPrompt(findings, from), s.sessionId, (e) => {
        if (e.type === "result") {
          answer = answerOf(e);
          sessionId = e.session_id ?? sessionId;
          usage = e;
        }
      }, { schema: RECHECK_SCHEMA });
      const results = parseRecheck(answer);
      if (!results) throw new Error(`${agent}'s answer didn't say which findings are fixed. Try again.`);
      update(k, (x) => ({
        ...x,
        sessionId,
        findingChecks: { from, head: details.headRefOid, at: Date.now(), results },
        tokens: (x.tokens ?? 0) + tokensOf(usage),
        costUsd: (x.costUsd ?? 0) + (usage.total_cost_usd ?? 0),
      }));
      setRecheckRuns((r) => ({ ...r, [k]: { running: false } }));
      track("findings_rechecked", { harness: settings.harness, findings: bucket(findings.length) });
    } catch (e) {
      setRecheckRuns((r) => ({ ...r, [k]: { running: false, error: errorText(e) } }));
    }
  };

  const stepFinding = (delta: number) => {
    if (!analysis?.findings.length) return;
    const n = analysis.findings.length;
    const cur = diffTarget.finding ?? (outlineKey[0] === "f" ? Number(outlineKey.slice(1)) : -1);
    const next = (cur + delta + n) % n;
    if (tab === "diff" && analysis.findings[next].anchors[0]) openAnchor(analysis.findings[next].anchors[0], next);
    setOutlineKey(`f${next}`);
  };

  // Vim-style keys when no text field has focus: h/l pick a pane (inbox, side list, content),
  // j/k move inside it, and single letters run common actions. Ctrl shortcuts live in `commands`.
  const vimRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const pendingG = useRef(0);
  vimRef.current = (e: KeyboardEvent) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable]");
    if (typing) {
      // Esc leaves a text field, back to the keys.
      if (e.key === "Escape" && t instanceof HTMLElement && !paletteOpen && !reviewOpen) t.blur();
      return;
    }
    if (!settings.vimKeys || paletteOpen || infoDialog || reviewOpen || descOpen || filtersOpen || settingsOpen || e.metaKey || e.altKey) return;
    // A focused button already handles Enter and Space itself.
    if (t instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;

    const panes = PANES.filter((p) => paneEl(p));
    const pane: Pane = panes.includes(focusPane) ? focusPane : panes[0] ?? "inbox";
    const scrollContent = (dy: number | "top" | "bottom") => {
      const el = paneEl("content");
      if (!el) return;
      if (dy === "top") el.scrollTo({ top: 0 });
      else if (dy === "bottom") el.scrollTo({ top: el.scrollHeight });
      else el.scrollBy({ top: dy });
    };
    const move = (p: Pane, to: number | "first" | "last") => {
      const list = navItems(p);
      if (!list.length) return;
      const cur = list.findIndex(isCurrent);
      const i = to === "first" ? 0 : to === "last" ? list.length - 1 : Math.min(list.length - 1, Math.max(0, (cur < 0 ? (to > 0 ? -1 : list.length) : cur) + to));
      list[i].click();
      list[i].scrollIntoView({ block: "nearest" });
    };
    const go = (to: number | "first" | "last") => {
      if (pane === "content") scrollContent(to === "first" ? "top" : to === "last" ? "bottom" : to * 80);
      else move(pane, to);
    };
    const switchPane = (d: number) => {
      const i = panes.indexOf(pane);
      const next = panes[Math.min(panes.length - 1, Math.max(0, i + d))];
      if (next) setFocusPane(next);
    };

    if (e.ctrlKey) {
      const half = (paneEl("content")?.clientHeight ?? 600) / 2;
      if (e.key === "d") { e.preventDefault(); scrollContent(half); }
      if (e.key === "u") { e.preventDefault(); scrollContent(-half); }
      return;
    }

    const now = Date.now();
    const g = e.key === "g" && now - pendingG.current < 600;
    pendingG.current = e.key === "g" && !g ? now : 0;
    const run = (f: () => void) => { e.preventDefault(); f(); };
    switch (e.key) {
      case "j": case "ArrowDown": return run(() => go(1));
      case "k": case "ArrowUp": return run(() => go(-1));
      case "g": return g ? run(() => go("first")) : undefined;
      case "G": return run(() => go("last"));
      case "h": return run(() => switchPane(-1));
      case "l": case "Enter": return run(() => switchPane(1));
      case "n": return run(() => stepFinding(1));
      case "N": return run(() => stepFinding(-1));
      case "]": return run(() => move("outline", 1));
      case "[": return run(() => move("outline", -1));
      case "1": return run(() => setTab("analysis"));
      case "2": return run(() => setTab("diff"));
      case "x": return run(() => document.querySelector<HTMLElement>("[data-review-toggle]")?.click());
      case "a": return run(() => document.querySelector<HTMLElement>('[data-key="add-review"]')?.click());
      case "i": return selected ? run(() => { setChatOpen(true); setChatFocus((c) => c + 1); }) : undefined;
      case "/": return run(() => (pane === "inbox" ? document.querySelector<HTMLElement>('[data-key="filter"]')?.focus() : setPaletteOpen(true)));
      case "r": return run(refresh);
      case "S": return details ? run(() => setReviewOpen(true)) : undefined;
      case "O": return selected ? run(() => openUrl(selected.url)) : undefined;
      case "?": return run(() => setInfoDialog("shortcuts"));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => vimRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Show which pane the keys act on. React doesn't manage this attribute, so it survives renders.
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-pane]")) el.toggleAttribute("data-focused", el.dataset.pane === focusPane);
  });

  const details = loaded && loaded.key === key ? loaded.details : null;
  const files = loaded && loaded.key === key ? loaded.files : [];
  const since = key ? sinceReviews[key] : undefined;
  const lastReview = since?.review ?? null;
  const hasNewCommits = !!(details && lastReview && lastReview.commitId !== details.headRefOid);
  const rangeFiles = diffRange === "since" && since?.files ? since.files : files;
  const diffFiles = useMemo(() => (settings.hideWhitespace ? ignoreWhitespace(rangeFiles) : rangeFiles), [rangeFiles, settings.hideWhitespace]);
  /** Lines picked in the diff that the next chat question is about. */
  const [lineContext, setLineContext] = useState<ChatContext | null>(null);
  useEffect(() => setLineContext(null), [key]);
  const analysisHead = session?.analysisHead ?? session?.headOid;
  /** The findings were made on an older commit than the PR's current head. */
  const analysisOutdated = !!(details && analysis?.findings.length && analysisHead && analysisHead !== details.headRefOid);
  const checks = session?.findingChecks && details && session.findingChecks.head === details.headRefOid ? session.findingChecks : undefined;
  const recheck = key ? recheckRuns[key] : undefined;
  /** Finding states for the current analysis, by finding index. */
  const findingStates = useMemo(() => {
    const out: Record<number, FindingState> = {};
    analysis?.findings.forEach((f, i) => {
      const st = session?.findingStates?.[findingId(f)];
      if (st) out[i] = st;
    });
    return out;
  }, [analysis, session?.findingStates]);
  const setFindingState = (i: number, st: FindingState | null) => {
    const f = analysis?.findings[i];
    if (!key || !f) return;
    update(key, (s) => {
      const all = { ...(s.findingStates ?? {}) };
      if (st) all[findingId(f)] = st;
      else delete all[findingId(f)];
      return { ...s, findingStates: all, inReview: st && st.state !== "commented" ? s.inReview.filter((x) => x !== i) : s.inReview };
    });
  };

  // Your last review of the selected PR, to offer "since your review" when new commits arrived.
  const login = orgs?.login;
  useEffect(() => {
    if (!key || !details || !selected || !login || sinceReviews[key]) return;
    const k = key;
    api
      .lastReview(selected.repository.nameWithOwner, details.number, login)
      .then((review) => setSinceReviews((all) => ({ ...all, [k]: { review } })))
      .catch(() => setSinceReviews((all) => ({ ...all, [k]: { review: null } })));
  }, [key, details, login]);
  useEffect(() => setDiffRange("all"), [key]);

  const showSinceReview = () => {
    if (!key || !details || !selected || !lastReview) return;
    setTab("diff");
    setDiffRange("since");
    if (since?.files || since?.loading) return;
    const k = key;
    setSinceReviews((all) => ({ ...all, [k]: { ...all[k], loading: true, error: undefined } }));
    api
      .diffSince(selected.repository.nameWithOwner, details.number, details.baseRefName, lastReview.commitId)
      .then((r) => setSinceReviews((all) => ({ ...all, [k]: { ...all[k], loading: false, commits: r.commits, files: parseDiff(r.diff, { nearbySequences: "zip" }) } })))
      .catch((e) => {
        setSinceReviews((all) => ({ ...all, [k]: { ...all[k], loading: false, error: errorText(e) } }));
        setDiffRange("all");
      });
  };
  const run = key ? runs[key] : undefined;
  const analyzing = useMemo(() => new Set(Object.entries(runs).filter(([, r]) => r.running).map(([k]) => k)), [runs]);

  // Auto-analyze: review requests that arrived after it was turned on, a few at a time.
  const autoTried = useRef(new Set<string>());
  const autoQueue = useMemo(() => {
    // Until saved sessions are read, every PR looks like it was never analyzed.
    if (!settings.autoAnalyze || !visibleRequests || !inboxLive || !sessionsReady || sample) return [];
    const since = settings.autoAnalyzeSince ?? Date.now();
    return visibleRequests.filter((pr) => {
      const k = prKey(pr);
      if (sessions[k]?.analysis || runs[k] || autoTried.current.has(k)) return false;
      if (pr.isDraft && !settings.autoAnalyzeDrafts) return false;
      return new Date(waitingSince(pr)).getTime() >= since;
    });
  }, [settings.autoAnalyze, settings.autoAnalyzeSince, settings.autoAnalyzeDrafts, visibleRequests, sessions, runs, inboxLive, sessionsReady, sample]);
  useEffect(() => {
    const free = settings.autoAnalyzeLimit - analyzing.size;
    for (const pr of autoQueue.slice(0, Math.max(0, free))) {
      const k = prKey(pr);
      autoTried.current.add(k);
      setRun(k, () => ({ running: true, step: "Loading the pull request…", log: [] }));
      api
        .prDetails(pr.repository.nameWithOwner, pr.number)
        .then((d) => runAnalysis(k, pr, d, { background: true }))
        .catch((e) => setRun(k, (r) => ({ ...r, running: false, error: errorText(e) })));
    }
  }, [autoQueue, analyzing.size, settings.autoAnalyzeLimit]);
  const queued = useMemo(() => new Set(autoQueue.map(prKey)), [autoQueue]);
  const critHigh = analysis?.findings.filter((f) => f.severity === "critical" || f.severity === "high").length ?? 0;
  const ci = details?.statusCheckRollup ?? [];
  const ciFailing = ci.some((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes((c.conclusion ?? c.state ?? "").toUpperCase()));
  const ciPending = ci.some((c) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes((c.status ?? c.state ?? "").toUpperCase()));

  // Review progress, shared by the guided steps and the file list.
  const reviewedHunks = useMemo(() => new Set(session?.reviewedHunks ?? []), [session?.reviewedHunks]);
  const setReviewed = (hunkKeys: string[], value: boolean) =>
    key &&
    update(key, (s) => {
      const set = new Set(s.reviewedHunks ?? []);
      hunkKeys.forEach((h) => (value ? set.add(h) : set.delete(h)));
      return { ...s, reviewedHunks: [...set] };
    });

  // What the chat question is about: the finding, claim or file the user is looking at.
  const chatContext = ((): ChatContext | null => {
    if (lineContext) return lineContext;
    if (tab === "analysis" && analysis) {
      const k = outlineKey[0];
      const i = Number(outlineKey.slice(1));
      const f = k === "f" ? analysis.findings[i] : undefined;
      if (f) {
        return {
          label: `Finding ${i + 1}: ${f.title}`,
          prompt: `The question is about finding ${i + 1} from your analysis: "${f.title}" (${f.anchors.map(anchorLabel).join(", ")}).`,
          suggestions: ["Is this a real problem?", "How would you fix it?", "Draft a review comment for this"],
        };
      }
      const u = k === "u" ? analysis.unmentioned?.[i] : undefined;
      if (u) {
        return {
          label: `Not in description: ${u.text}`,
          prompt: `The question is about this change, which the PR description doesn't mention: "${u.text}" (${u.anchors.map(anchorLabel).join(", ") || "no location"}).`,
          suggestions: ["Why might this have changed?", "Is this safe?", "Draft a question for the author"],
        };
      }
      const c = k === "c" ? analysis.claims[i] : undefined;
      if (c) {
        return {
          label: `Claim ${i + 1}: ${c.text}`,
          prompt: `The question is about this claim from the PR description: "${c.text}" (your verdict: ${c.verdict}).`,
          suggestions: ["Where is this implemented?", "What is missing?", "Draft a review comment for this"],
        };
      }
    }
    const step = tab === "diff" && diffMode === "guided" ? guideTopic ?? analysis?.walkthrough?.[guideStep] : undefined;
    if (step) {
      return {
        label: `Step ${guideStep + 1}: ${step.title}`,
        prompt: `The question is about step ${guideStep + 1} of the guided review, "${step.title}", which covers ${step.changes.map(anchorLabel).join(", ")}.`,
        suggestions: ["Explain this step", "What could go wrong here?", "Is this covered by tests?"],
      };
    }
    if (tab === "diff" && diffMode === "files" && diffTarget.path) {
      const r = diffTarget.range;
      const where = r && r.startLine > 0 ? anchorLabel(r) : diffTarget.path.split("/").pop() ?? diffTarget.path;
      return {
        label: where,
        prompt: `The question is about ${diffTarget.path}${r && r.startLine > 0 ? ` lines ${r.startLine}-${r.endLine}` : ""} in this PR.`,
        suggestions: ["Explain this change", "What calls this code?", "Is this covered by tests?"],
      };
    }
    return null;
  })();
  const chatHasContent = (session?.chat.length ?? 0) > 0 || !!(key && chatRunning[key]);
  const chatProps = {
    chat: session?.chat ?? [],
    running: !!(key && chatRunning[key]),
    context: chatContext,
    focusSignal: chatFocus,
    onSend: (text: string, ctx: ChatContext | null) => {
      sendChat(text, ctx);
      if (ctx && ctx === lineContext) setLineContext(null);
    },
    onCancel: () => key && runIds.current[`chat-${key}`] && api.claudeCancel(runIds.current[`chat-${key}`]),
    onClear: () => key && update(key, (s) => ({ ...s, chat: [] })),
    onHide: () => setChatOpen(false),
  };

  // ⌘F / Ctrl+F: the search lives in the file diff, so switch to it, then open or focus the search box.
  const findInDiff = () => {
    setTab("diff");
    if (diffMode === "guided") setDiffMode("files");
    let tries = 0;
    const open = () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search the diff"]');
      if (input) return (input.focus(), input.select());
      const btn = document.querySelector<HTMLElement>('[data-key="diff-search"]');
      if (btn) return btn.click();
      if (tries++ < 20) setTimeout(open, 50);
    };
    requestAnimationFrame(open);
  };

  const openInEditor = () => session?.worktree && openInVsCode(session.worktree);
  const canAnalyze = !!(details && !run?.running);
  const commands: Command[] = [
    { id: "refresh", menu: "File", label: "Refresh pull requests", keys: { key: "r", ctrl: true }, altKeys: [{ key: "F5" }], run: refresh },
    { id: "github", menu: "File", label: "Open pull request on GitHub", keys: { key: "o", ctrl: true, shift: true }, enabled: !!selected, run: () => selected && openUrl(selected.url), separatorBefore: true },
    { id: "editor", menu: "File", label: "Open worktree in VS Code", keys: { key: "e", ctrl: true }, enabled: !!session?.worktree, run: openInEditor },
    { id: "settings", menu: "File", label: "Settings…", keys: { key: ",", ctrl: true }, run: () => openSettings("general"), separatorBefore: true },
    { id: "quit", menu: "File", label: "Quit", keys: { key: "q", ctrl: true }, run: () => getCurrentWindow().close(), separatorBefore: true },

    { id: "filters", menu: "View", label: "Sort and filter…", run: () => setFiltersOpen(true) },
    { id: "palette", menu: "View", label: "Go to…", keys: { key: "k", ctrl: true }, run: () => setPaletteOpen(true) },
    { id: "inbox", menu: "View", label: "Inbox panel", checked: inboxOpen, keys: { key: "b", ctrl: true }, run: () => setInboxOpen(!inboxOpen), separatorBefore: true },
    { id: "chat", menu: "View", label: `${agent} panel`, checked: chatOpen, keys: { key: "j", ctrl: true }, run: () => setChatOpen(!chatOpen) },
    { id: "tab-analysis", menu: "View", label: "Analysis", checked: !!selected && tab === "analysis", enabled: !!selected, keys: { key: "1", ctrl: true }, run: () => setTab("analysis"), separatorBefore: true },
    { id: "tab-diff", menu: "View", label: "Diff", checked: !!selected && tab === "diff", enabled: !!selected, keys: { key: "2", ctrl: true }, run: () => setTab("diff") },
    { id: "find", menu: "View", label: "Find in diff…", enabled: !!details, keys: { key: "f", ctrl: true }, run: findInDiff },
    { id: "guided", menu: "View", label: "Guided review", checked: diffMode === "guided", run: () => { setDiffMode("guided"); if (selected) setTab("diff"); }, separatorBefore: true },
    { id: "files", menu: "View", label: "All files", checked: diffMode === "files", run: () => { setDiffMode("files"); if (selected) setTab("diff"); } },
    { id: "split", menu: "View", label: "Split diff", checked: split, run: () => setSplit(!split) },
    { id: "theme-system", menu: "View", label: "System theme", checked: settings.theme === "system", run: () => updateSettings({ theme: "system" }), separatorBefore: true },
    { id: "theme-light", menu: "View", label: "Light theme", checked: settings.theme === "light", run: () => updateSettings({ theme: "light" }) },
    { id: "theme-dark", menu: "View", label: "Dark theme", checked: settings.theme === "dark", run: () => updateSettings({ theme: "dark" }) },
    { id: "zoom-in", menu: "View", label: "Zoom in", keys: { key: "=", ctrl: true }, altKeys: [{ key: "+", ctrl: true, shift: true }, { key: "+", ctrl: true }], run: () => updateSettings({ zoom: stepZoom(settings.zoom, 1) }), separatorBefore: true },
    { id: "zoom-out", menu: "View", label: "Zoom out", keys: { key: "-", ctrl: true }, run: () => updateSettings({ zoom: stepZoom(settings.zoom, -1) }) },
    { id: "zoom-reset", menu: "View", label: "Actual size", keys: { key: "0", ctrl: true }, enabled: settings.zoom !== 1, run: () => updateSettings({ zoom: 1 }) },

    { id: "analyze", menu: "Review", label: analysis ? "Re-run analysis" : "Start review", enabled: canAnalyze, run: () => { setTab("analysis"); startAnalysis(); } },
    { id: "guide", menu: "Review", label: "Create guided review", enabled: !!(analysis && !analysis.walkthrough && session?.sessionId && !(key && guideRuns[key]?.running)), run: () => { setDiffMode("guided"); setTab("diff"); generateWalkthrough(); } },
    { id: "next", menu: "Review", label: "Next finding", hint: "n", enabled: !!analysis?.findings.length, run: () => stepFinding(1), separatorBefore: true },
    { id: "prev", menu: "Review", label: "Previous finding", hint: comboLabel({ key: "N", shift: true }), enabled: !!analysis?.findings.length, run: () => stepFinding(-1) },
    { id: "describe", menu: "Review", label: "Edit description…", enabled: !!details && !!orgs?.login && details.author.login === orgs.login, run: () => setDescOpen(true) },
    { id: "submit", menu: "Review", label: "Submit review…", keys: { key: "Enter", ctrl: true, shift: true }, enabled: !!details, run: () => setReviewOpen(true), separatorBefore: true },
    { id: "ask", menu: "Review", label: `Ask ${agent}`, keys: { key: "l", ctrl: true }, enabled: !!selected, run: () => { setChatOpen(true); setChatFocus((n) => n + 1); }, separatorBefore: true },
    { id: "clear-chat", menu: "Review", label: "Clear conversation", enabled: !!session?.chat.length, run: () => key && update(key, (s) => ({ ...s, chat: [] })) },

    { id: "shortcuts", menu: "Help", label: "Keyboard shortcuts", keys: { key: "/", ctrl: true }, run: () => setInfoDialog("shortcuts") },
    { id: "sample", menu: "Help", label: sample ? "Leave the sample" : "Try a sample pull request", run: () => (sample ? leaveSample() : enterSample()), separatorBefore: true },
    { id: "setup", menu: "Help", label: "Check setup…", enabled: !sample, run: () => { setSettingsOpen(false); setSetupOpen(true); checkTools(); } },
    { id: "updates", menu: "Help", label: "Check for updates…", enabled: updater.supported, run: () => updater.checkNow(true), separatorBefore: true },
    { id: "whats-new", menu: "Help", label: "What's new", enabled: !!currentVersion && hasNotes(currentVersion), run: () => currentVersion && setWhatsNew(currentVersion) },
    { id: "about", menu: "Help", label: "About BetterLGTM", run: () => setInfoDialog("about") },
  ];
  commandsRef.current = commands;
  useNativeMenu(commands);

  // The macOS Settings window: send it what the Organizations page lists, and run its actions here.
  const settingsData: SettingsData = { orgs, orgsError, requests };
  const settingsDataRef = useRef(settingsData);
  settingsDataRef.current = settingsData;
  const settingsActions = useRef({ reloadOrgs, clearAll });
  settingsActions.current = { reloadOrgs, clearAll };
  useEffect(() => {
    if (useSettingsWindow) emitTo(SETTINGS_LABEL, SETTINGS_EV.data, settingsDataRef.current).catch(() => {});
  }, [orgs, orgsError, requests]);
  useEffect(() => {
    if (!useSettingsWindow) return;
    const un = [
      listen(SETTINGS_EV.ready, () => emitTo(SETTINGS_LABEL, SETTINGS_EV.data, settingsDataRef.current)),
      listen(SETTINGS_EV.reloadOrgs, () => settingsActions.current.reloadOrgs()),
      listen(SETTINGS_EV.clearData, () => settingsActions.current.clearAll()),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);
  useEffect(() => {
    if (!inTauri) return;
    // One handler: the window closes as soon as any close handler returns, so the save can't have its own.
    const un = getCurrentWindow().onCloseRequested(async () => {
      // Save what's pending, but never hold the window open for long.
      await Promise.race([flushSessions(), new Promise((done) => setTimeout(done, 1500))]);
      // Settings belongs to the main window: close it with the main window, so the app quits.
      if (useSettingsWindow) await closeSettingsWindow();
    });
    return () => void un.then((f) => f());
  }, []);
  // With the system title bar, the window title names the open pull request.
  const windowTitle = selected ? `${selected.repository.nameWithOwner} #${selected.number} · ${selected.title}` : "BetterLGTM";
  useEffect(() => {
    document.title = windowTitle;
    if (inTauri) getCurrentWindow().setTitle(windowTitle).catch(() => {});
  }, [windowTitle]);

  /** A palette item that opens any PR typed as a GitHub link or owner/repo#number. */
  const openPrItem = (q: string): PaletteItem | null => {
    const m = q.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) ?? q.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
    if (!m) return null;
    const [repo, number] = [m[1], Number(m[2])];
    return {
      id: `open-${repo}#${number}`,
      group: "Open",
      label: `Open ${repo}#${number}`,
      icon: <GitPullRequestArrow size={14} />,
      run: () =>
        selectPr({
          number,
          title: `${repo}#${number}`,
          url: `https://github.com/${repo}/pull/${number}`,
          isDraft: false,
          updatedAt: new Date().toISOString(),
          author: { login: "" },
          repository: { name: repo.split("/")[1], nameWithOwner: repo },
        }),
    };
  };

  // Everything the ⌘K / Ctrl+K palette can jump to.
  const paletteItems: PaletteItem[] = paletteOpen
    ? [
        ...[...(visibleRequests ?? []), ...(visibleMine ?? []).filter((m) => !visibleRequests?.some((r) => prKey(r) === prKey(m)))].map((pr) => ({
          id: `pr-${prKey(pr)}`,
          group: "Pull requests",
          label: pr.title,
          detail: `${pr.repository.nameWithOwner} #${pr.number}`,
          icon: <GitPullRequestArrow size={14} />,
          run: () => selectPr(pr),
        })),
        ...(analysis?.findings ?? []).map((f, i) => {
          const sev = SEVERITY[f.severity];
          return {
            id: `f-${i}`,
            group: "Findings",
            label: f.title,
            detail: `${sev.label} · finding ${i + 1}`,
            icon: <sev.icon size={14} className={sev.tone} />,
            run: () => { setTab("analysis"); setOutlineKey(`f${i}`); setFocusPane("outline"); },
          };
        }),
        ...(analysis?.walkthrough ?? []).map((s, i) => ({
          id: `s-${i}`,
          group: "Guided review sections",
          label: s.title,
          detail: `Section ${i + 1}`,
          icon: <ListOrdered size={14} />,
          run: () => { setDiffMode("guided"); setTab("diff"); setGuideStep(i); setGuideTopic(undefined); },
        })),
        ...files.map((f) => {
          const path = filePath(f);
          const Icon = fileIcon(path);
          return {
            id: `file-${path}`,
            group: "Changed files",
            label: path.split("/").pop() ?? path,
            detail: path,
            icon: <Icon size={14} />,
            run: () => openAnchor({ path, startLine: 0, endLine: -1 }, null),
          };
        }),
        ...commands
          .filter((c) => c.enabled !== false && c.id !== "palette")
          .map((c) => ({ id: `cmd-${c.id}`, group: "Commands", label: c.label, detail: shortcutLabel(c), icon: <Terminal size={14} />, run: c.run })),
      ]
    : [];

  /** With nothing in the list, the middle of the window says why and what to do instead. */
  const emptyInbox = !!inboxList && inboxList.length === 0;
  const main = !selected ? (
    <div className="empty">
      <div style={{ maxWidth: 440 }}>
        <InboxIcon size={40} strokeWidth={1.4} style={{ opacity: 0.7 }} />
        {inboxError && !inboxList?.length ? (
          <>
            <h1 style={{ margin: "8px 0 4px", fontSize: 15, color: "var(--text)" }}>Couldn't load your pull requests</h1>
            <p className="selectable" style={{ margin: 0 }}>{inboxError}</p>
            <div className="empty-actions">
              <button type="button" className="btn primary" onClick={refresh}><RefreshCw size={14} className={inboxLoading ? "spin" : undefined} />Try again</button>
              <button type="button" className="btn" onClick={() => { setSetupOpen(true); checkTools(); }}>Check setup</button>
            </div>
          </>
        ) : emptyInbox ? (
          <>
            <h1 style={{ margin: "8px 0 4px", fontSize: 15, color: "var(--text)" }}>{inboxView === "mine" ? "You have no open pull requests" : "Nothing is waiting for your review"}</h1>
            <p style={{ margin: 0 }}>
              {inboxView === "mine"
                ? "Pull requests you open show up here, with what's blocking each one from merging."
                : "Pull requests where your review is requested show up here on their own. You can review any other pull request too."}
              {hiddenCount > 0 && <> {hiddenCount === 1 ? "1 is" : `${hiddenCount} are`} hidden by your organization settings. <button type="button" className="link" onClick={() => openSettings("orgs")}>Change</button></>}
            </p>
            <div className="empty-actions">
              <button type="button" className="btn primary" onClick={() => setPaletteOpen(true)}><GitPullRequestArrow size={14} />Open a pull request…</button>
              {inboxView === "review" && !!visibleMine?.length && (
                <button type="button" className="btn" onClick={() => setInboxView("mine")}>Your pull requests ({visibleMine.length})</button>
              )}
              {inboxView === "mine" && !!visibleRequests?.length && (
                <button type="button" className="btn" onClick={() => setInboxView("review")}>To review ({visibleRequests.length})</button>
              )}
              {!sample && <button type="button" className="btn" onClick={enterSample}><Sparkles size={14} />Try a sample</button>}
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 12 }}>To open one, paste its GitHub link or type <code>owner/repo#123</code>.</p>
          </>
        ) : (
          <>
            <h1 style={{ margin: "8px 0 4px", fontSize: 15, color: "var(--text)" }}>Select a pull request</h1>
            <p style={{ margin: 0 }}>
              {!visibleRequests ? "Loading review requests…" : visibleRequests.length === 1 ? "1 pull request is waiting for your review." : `${visibleRequests.length} pull requests are waiting for your review.`}
            </p>
          </>
        )}
      </div>
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <section aria-label="Pull request" className="prhead">
        <div className="prhead-row">
          <h1 className="ellipsis" title={details?.title ?? selected.title}>
            {details?.title ?? selected.title} <span className="muted" style={{ fontWeight: 400 }}>#{selected.number}</span>
          </h1>
          <div className="seg" role="group" aria-label="View">
            <button type="button" data-cmd="tab-analysis" className={tab === "analysis" ? "on" : ""} aria-pressed={tab === "analysis"} onClick={() => setTab("analysis")} title="Analysis">
              <ListChecks size={13} /><span className="lbl-text">Analysis</span>{critHigh > 0 && <span className="cnt crit">{critHigh}</span>}
            </button>
            <button type="button" data-cmd="tab-diff" className={tab === "diff" ? "on" : ""} aria-pressed={tab === "diff"} onClick={() => setTab("diff")} title="Diff">
              <FileDiff size={13} /><span className="lbl-text">Diff</span><span className="cnt">{files.length}</span>
            </button>
          </div>
          <button type="button" data-cmd="github" className="tb" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openUrl(selected.url)}><ExternalLink size={15} /></button>
          <button type="button" data-cmd="editor" className="btn" disabled={!session?.worktree} aria-label="Open in editor" title={session?.worktree ?? "The worktree is created when the review starts"} onClick={openInEditor}>
            <Code size={14} /><span className="lbl-text">Open in editor</span>
          </button>
          <button type="button" data-cmd="submit" className="btn primary" disabled={!details} aria-label="Submit review" title="Submit review on GitHub" onClick={() => setReviewOpen(true)}>
            <Send size={14} /><span className="lbl-text">Submit review…</span>{(session?.inReview.length ?? 0) + (session?.draftComments?.length ?? 0) > 0 && <span className="cnt on-primary">{(session?.inReview.length ?? 0) + (session?.draftComments?.length ?? 0)}</span>}
          </button>
        </div>
        {details && (
          <div className="prhead-meta muted">
            <span className="opt">{selected.repository.nameWithOwner}</span>
            <span className="opt">{details.author.login}</span>
            {(loaded && loaded.key === key ? loaded.issues : []).map((i) => (
              <button key={i.number} type="button" className="flink opt" title={i.title} onClick={() => openUrl(i.url)}>Closes #{i.number}</button>
            ))}
            <span className="ellipsis" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><GitBranch size={13} style={{ flexShrink: 0 }} /><span className="mono ellipsis">{details.headRefName} → {details.baseRefName}</span></span>
            <span style={{ whiteSpace: "nowrap" }}>+{details.additions} −{details.deletions} · {details.changedFiles} files</span>
            <span className={ciFailing ? "tone-crit" : ciPending ? "tone-high" : "tone-ok"} style={{ whiteSpace: "nowrap" }}>{ci.length === 0 ? "No CI" : ciFailing ? "CI failing" : ciPending ? "CI running" : "CI passing"}</span>
          </div>
        )}
        {details && <ReviewStatus details={details} me={orgs?.login} />}
      </section>
      {(hasNewCommits || analysisOutdated) && (
        <div className="since-bar" role="status" title={since?.commits?.map((c) => `${c.oid.slice(0, 7)} ${c.subject}`).join("\n")}>
          {since?.loading || recheck?.running ? <Loader size={14} className="spin" /> : <History size={14} className="tone-accent" />}
          <span className="ellipsis" style={{ minWidth: 0 }}>
            {hasNewCommits && lastReview ? (
              <>
                <strong>{since?.commits ? `${since.commits.length} new ${since.commits.length === 1 ? "commit" : "commits"}` : "New commits"}</strong>
                {` since you ${REVIEW_VERB[lastReview.state] ?? "reviewed"} ${ago(lastReview.submittedAt)}`}
              </>
            ) : (
              <strong>New commits since the analysis</strong>
            )}
            {checks ? (
              <span className="muted">{` · ${Object.values(checks.results).filter((r) => r.status === "fixed").length} of ${analysis?.findings.length ?? 0} findings fixed`}</span>
            ) : recheck?.running ? (
              <span className="muted"> · {agent} is re-checking the findings…</span>
            ) : null}
            {hasNewCommits && lastReview && session?.analysisSince === lastReview.commitId && <span className="muted"> · analysis covers them</span>}
          </span>
          <span style={{ flex: 1 }} />
          {hasNewCommits && lastReview && (
            <div className="seg" role="group" aria-label="Changes to show">
              <button type="button" className={tab === "diff" && diffRange === "since" ? "" : "on"} aria-pressed={!(tab === "diff" && diffRange === "since")} onClick={() => setDiffRange("all")}>All changes</button>
              <button type="button" className={tab === "diff" && diffRange === "since" ? "on" : ""} aria-pressed={tab === "diff" && diffRange === "since"} onClick={showSinceReview}>Since your review</button>
            </div>
          )}
          {analysisOutdated && !checks && (
            <button type="button" className="btn sm" disabled={!!recheck?.running || !!run?.running} onClick={() => { setTab("analysis"); recheckFindings(); }}>
              Re-check findings
            </button>
          )}
          {hasNewCommits && lastReview && (
            <button type="button" className="btn sm" disabled={!canAnalyze} onClick={() => { setTab("analysis"); startAnalysis({ since: lastReview.commitId }); }}>
              Analyze new changes
            </button>
          )}
        </div>
      )}
      {recheck?.error && <div className="since-bar tone-high" role="alert">{recheck.error}</div>}
      {since?.error && <div className="since-bar tone-high" role="alert">{since.error}</div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div className="empty"><Loader size={18} className="spin" /></div>}>
        {loadError && <p className="selectable" style={{ margin: 16, color: "var(--crit)" }}>{loadError}</p>}
        {!loadError && !details && <div className="empty"><Loader size={18} className="spin" /></div>}
        {details && tab === "analysis" && (
          <AnalysisView
            pr={details}
            bodyHtml={loaded?.bodyHtml}
            analysis={analysis}
            analysisRaw={session?.analysisRaw}
            analyzedAt={session?.analyzedAt}
            run={run}
            files={files}
            generated={generatedGlobs}
            selected={outlineKey}
            inReview={session?.inReview ?? []}
            checks={checks?.results}
            states={findingStates}
            onState={setFindingState}
            threads={loaded && loaded.key === key ? loaded.threads : []}
            ownPr={!!orgs?.login && details.author.login === orgs.login}
            analysisHead={analysisHead}
            onEditDescription={() => setDescOpen(true)}
            onThreadDraft={session?.worktree || selected ? draftReply : undefined}
            onThreadReply={replyToThread}
            onThreadResolve={resolveThread}
            onSelect={(k) => { setOutlineKey(k); setFocusPane("outline"); }}
            onOpenAnchor={openAnchor}
            onStart={() => startAnalysis()}
            onCancel={cancelAnalysis}
            onToggleReview={(i) => key && update(key, (s) => ({ ...s, inReview: s.inReview.includes(i) ? s.inReview.filter((x) => x !== i) : [...s.inReview, i] }))}
            onAsk={() => { setChatOpen(true); setChatFocus((n) => n + 1); }}
          />
        )}
        {/* Guided review covers the whole PR, so "since your review" always uses the file diff. */}
        {details && tab === "diff" && diffMode === "guided" && diffRange === "all" && (
          <GuidedReview
            files={diffFiles}
            steps={analysis?.walkthrough}
            findings={analysis?.findings ?? []}
            current={guideStep}
            reviewed={reviewedHunks}
            split={split}
            generating={key ? guideRuns[key] : undefined}
            canGenerate={!!(session?.sessionId && session.worktree)}
            onSplit={setSplit}
            onMode={setDiffMode}
            onStep={(i, s) => { setGuideStep(i); setGuideTopic(s); }}
            onReviewed={setReviewed}
            onGenerate={generateWalkthrough}
            hide={hideRules}
            predict={settings.predictFirst}
            answers={session?.probeAnswers}
            onAnswer={(pk, a) => key && update(key, (s) => ({ ...s, probeAnswers: { ...(s.probeAnswers ?? {}), [pk]: a } }))}
            onAsk={() => { setChatOpen(true); setChatFocus((n) => n + 1); }}
            onOpenAnchor={(a) => openAnchor(a, null)}
          />
        )}
        {details && tab === "diff" && (diffMode === "files" || diffRange === "since") && (
          <DiffView
            onMode={(m) => { if (m === "guided") setDiffRange("all"); setDiffMode(m); }}
            reviewed={reviewedHunks}
            onReviewed={setReviewed}
            hide={hideRules}
            files={diffFiles}
            current={diffTarget.path}
            range={diffTarget.range}
            findings={analysis?.findings ?? []}
            activeFinding={diffTarget.finding}
            split={split}
            onSplit={setSplit}
            onPickFile={(path, range) => setDiffTarget({ path, range: range ?? null, finding: null })}
            hideWhitespace={settings.hideWhitespace}
            onHideWhitespace={(v) => updateSettings({ hideWhitespace: v })}
            onLoadSource={(path) => api.fileAt(selected.repository.nameWithOwner, details.headRefOid, path)}
            onAskLines={(path, start, end, code) => {
              const where = `${path}:${start}${end > start ? `-${end}` : ""}`;
              setLineContext({
                label: where.split("/").pop() ?? where,
                prompt: `About ${where} in this PR:\n\`\`\`\n${code.slice(0, 4000)}\n\`\`\``,
                suggestions: ["What does this do?", "What could go wrong here?", "Is this tested?"],
              });
              setChatOpen(true);
              setChatFocus((c) => c + 1);
            }}
            onAddComment={(c) => key && update(key, (s) => ({ ...s, draftComments: [...(s.draftComments ?? []), c] }))}
            onSearchRepo={async (pattern, regex, cs) => {
              const wt = await ensureWorktree(key!, selected, details);
              return api.searchWorktree(wt, pattern, regex, cs);
            }}
            onOpenInEditor={(path, line) => session?.worktree && openInVsCode(session.worktree, path, line)}
            onBack={() => { if (diffTarget.finding !== null) setOutlineKey(`f${diffTarget.finding}`); setTab("analysis"); }}
            onStepFinding={stepFinding}
          />
        )}
        </Suspense>
      </div>
    </div>
  );

  return (
    <AgentContext.Provider value={harnessOf(settings)}>
    <div className="app" ref={appRef}>
      <Toolbar
        title={selected ? `${selected.repository.nameWithOwner} #${selected.number} · ${selected.title}` : "Jump to a PR, file or finding"}
        inboxOpen={inboxOpen}
        chatOpen={chatOpen}
        onToggleInbox={() => setInboxOpen(!inboxOpen)}
        onToggleChat={() => setChatOpen(!chatOpen)}
        onOpenSettings={() => openSettings("general")}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      {sample && (
        <div className="since-bar" role="status">
          <Sparkles size={14} className="tone-accent" />
          <span style={{ flex: 1 }}><strong>Sample pull requests.</strong> Nothing here reaches GitHub or uses a coding agent; reviews you submit go nowhere.</span>
          <button type="button" className="btn sm" onClick={leaveSample}>Leave the sample</button>
        </div>
      )}
      {onboarding && !settingsOpen && (
        <div className="main-pane" style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={null}>
            <Onboarding
              step={onboarding}
              status={toolStatus}
              checking={toolChecking}
              firstRun={!settings.onboarded}
              settings={settings}
              update={updateSettings}
              orgs={orgs}
              onCheck={checkTools}
              onSetPaths={() => openSettings("tools")}
              onSample={enterSample}
              onContinue={() => { setSetupOpen(false); setSetupSkipped(setupIsBroken); setFirstStep("agent"); }}
              onStep={setFirstStep}
              onDone={() => { updateSettings({ onboarded: true }); track("onboarding_finished", { harness: settings.harness }); }}
            />
          </Suspense>
        </div>
      )}
      {settingsOpen && (
        <div className="main-pane" style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={null}>
          <Settings
            settings={settings}
            update={updateSettings}
            section={settingsSection}
            onSection={setSettingsSection}
            orgs={orgs}
            orgsError={orgsError}
            requests={requests}
            onReloadOrgs={reloadOrgs}
            onClearData={clearAll}
            onClose={() => setSettingsOpen(false)}
          />
          </Suspense>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: settingsOpen || onboarding ? "none" : "flex" }}>
        {inboxMode === "rail" && (
          <div className="inbox-pane" style={{ width: 52, flexShrink: 0, borderRight: "1px solid var(--line)" }}>
            <InboxRail
              onPrefetch={prefetchPr}
              requests={inboxList}
              selected={key}
              sessions={sessions}
              analyzing={analyzing}
              onSelect={selectPr}
              onExpand={() => setInboxExpanded(true)}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
        <Group orientation="horizontal">
          {inboxMode === "full" && (
            <>
              <Panel id="inbox" className="inbox-pane" defaultSize={compact ? 260 : 280} minSize={220} maxSize={420}>
                <Inbox
                  onPrefetch={prefetchPr}
                  view={inboxView}
                  counts={{ review: visibleRequests?.length ?? 0, mine: visibleMine?.length ?? 0 }}
                  onViewChange={setInboxView}
                  sort={inboxSort}
                  filters={inboxFilters}
                  activeFilters={activeFilters}
                  onOpenFilters={() => setFiltersOpen(true)}
                  onClearFilters={clearFilters}
                  requests={inboxList}
                  hiddenCount={hiddenCount}
                  error={inboxError}
                  loading={inboxLoading}
                  selected={key}
                  focused={focusPane === "inbox"}
                  sessions={sessions}
                  analyzing={analyzing}
                  queued={queued}
                  onSelect={(pr) => { selectPr(pr); if (compact) setInboxExpanded(false); }}
                  onRefresh={refresh}
                  onHideOwner={hideOwner}
                  onHideRepo={(r) => setRepoVisible(r, false)}
                  onManage={() => openSettings("orgs")}
                  onCollapse={compact ? () => setInboxExpanded(false) : undefined}
                />
              </Panel>
              <Separator className="sep-v" />
            </>
          )}
          <Panel id="main" className="main-pane" minSize={420}>
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ flex: 1, minHeight: 0 }}>
            <Group orientation="vertical">
              <Panel id="content" minSize={200}>{main}</Panel>
              {chatOpen && selected && chatHasContent && (
                <>
                  <Separator className="sep-h" />
                  <Panel id="chat" defaultSize={260} minSize={140}>
                    <ClaudePanel {...chatProps} compact={false} />
                  </Panel>
                </>
              )}
            </Group>
            </div>
            {chatOpen && selected && !chatHasContent && <ClaudePanel {...chatProps} compact />}
            </div>
          </Panel>
        </Group>
        </div>
      </div>
      <footer className="statusbar" aria-label="Status bar">
        <span className="sb"><RefreshCw size={13} className={inboxLoading ? "spin" : undefined} />{syncedAt ? `Synced ${new Date(syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Syncing…"}</span>
        <span className="sb opt"><InboxIcon size={13} />{visibleRequests?.length ?? 0} to review</span>
        <span style={{ flex: 1 }} />
        {key && postedReviews[key] && (
          <button type="button" className="sb sb-btn" onClick={() => openUrl(postedReviews[key])}><Check size={13} />Review posted · View on GitHub</button>
        )}
        <UpdateStatus {...updater} />
        {key && (
          <span className="sb">
            {run?.running || chatRunning[key] ? <Loader size={13} className="spin tone-accent" /> : <MessageSquare size={13} />}
            {harnessOf(settings).name} {run?.running || chatRunning[key] ? "working" : "idle"}{session?.tokens ? ` · ${Math.round(session.tokens / 1000)}k tokens` : ""}
          </span>
        )}
        {details && <span className="sb opt ellipsis"><GitBranch size={13} />{details.headRefName} @ {details.headRefOid.slice(0, 7)}</span>}
        {sample && <span className="sb"><Sparkles size={13} />Sample</span>}
        <span className="sb opt"><Lock size={13} />Read-only</span>
      </footer>
      <Suspense fallback={null}>
      <ShortcutHints commandsRef={commandsRef} />
      {paletteOpen && <CommandPalette items={paletteItems} extra={openPrItem} onClose={() => setPaletteOpen(false)} />}
      {descOpen && details && (
        <DescriptionDialog key={key} current={details.body ?? ""} onDraft={draftDescription} onSave={saveDescription} onClose={() => setDescOpen(false)} />
      )}
      {filtersOpen && (
        <FilterDialog
          sort={inboxSort}
          onSort={setInboxSort}
          filters={inboxFilters}
          onFilters={setInboxFilters}
          showDrafts={settings.showDrafts}
          onShowDrafts={(v) => updateSettings({ showDrafts: v })}
          owners={ownerRows}
          onOwner={setOwnerVisible}
          repos={repoRows}
          onRepo={setRepoVisible}
          onClear={clearFilters}
          onManageOrgs={() => { setFiltersOpen(false); openSettings("orgs"); }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
      {reviewOpen && selected && details && key && (
        <SubmitReview
          key={key}
          repo={selected.repository.nameWithOwner}
          details={details}
          analysis={analysis}
          files={files}
          inReview={session?.inReview ?? []}
          ownPr={!!orgs?.login && details.author.login === orgs.login}
          analysisHead={analysisHead}
          checks={checks?.results}
          states={findingStates}
          drafts={session?.draftComments ?? []}
          onDrafts={(d) => update(key, (s) => ({ ...s, draftComments: d }))}
          onDraftSummary={session?.worktree ? (event, comments, notes) => draftSummary(event, comments, notes) : undefined}
          onClose={() => setReviewOpen(false)}
          onSubmitted={(url, posted) => {
            const findings = analysis?.findings ?? [];
            update(key, (s) => ({
              ...s,
              draftComments: [],
              findingStates: { ...(s.findingStates ?? {}), ...Object.fromEntries(posted.filter((i) => findings[i]).map((i) => [findingId(findings[i]), { state: "commented" as const, at: Date.now() }])) },
            }));
            setReviewOpen(false);
            // Show the new review state, and drop the PR from "To review" if the request is done.
            const repo = selected.repository.nameWithOwner;
            api.prDetails(repo, selected.number).then((d) => setLoaded((l) => (l && l.key === key ? { ...l, details: d } : l))).catch(() => {});
            refresh();
            setPostedReviews((all) => ({ ...all, [key]: url }));
            update(key, (s) => ({ ...s, inReview: [] }));
          }}
        />
      )}
      {whatsNew && <WhatsNew version={whatsNew} onClose={() => setWhatsNew(null)} />}
      {infoDialog && <InfoDialog kind={infoDialog} commands={commands} vim={settings.vimKeys} onClose={() => setInfoDialog(null)} />}
      </Suspense>
    </div>
    </AgentContext.Provider>
  );
}

function UpdateStatus({ state, install, restart }: ReturnType<typeof useUpdater>) {
  switch (state.kind) {
    case "checking":
      return state.manual ? <span className="sb"><Loader size={13} className="spin" />Checking for updates…</span> : null;
    case "current":
      return state.manual ? <span className="sb"><Check size={13} />BetterLGTM is up to date</span> : null;
    case "error":
      return state.manual ? <span className="sb tone-high" title={state.message}><TriangleAlert size={13} />Couldn't update</span> : null;
    case "available":
      return <button type="button" className="sb sb-btn" onClick={install}><Download size={13} />Install update {state.version}</button>;
    case "installing":
      return <span className="sb"><Loader size={13} className="spin" />Updating{state.percent !== null ? ` ${state.percent}%` : "…"}</span>;
    case "ready":
      return <button type="button" className="sb sb-btn" onClick={() => restart()}><RotateCw size={13} />Restart to finish updating</button>;
    default:
      return null;
  }
}
