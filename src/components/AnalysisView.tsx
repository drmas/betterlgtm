import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft, ChevronDown, ChevronRight, ChevronUp, CircleCheck, ExternalLink, FileDiff, FileText, FileX, Flag, Funnel,
  BadgeCheck, CircleDashed, Sparkles, CircleSlash, CircleX, ShieldAlert, LayoutDashboard, Loader, MessageSquare, MessageSquarePlus, OctagonExclamationPoint, Play, RefreshCw, RotateCcw, Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { FileData } from "react-diff-view";
import { anchorLabel, buildHandoffPrompt, isDisputed, outlineOrder, type Analysis, type Anchor, type CheckStatus, type Decision, type FindingCheck, type FindingState } from "../analysis";
import { contextMenu, copyText } from "../contextMenu";
import { errorText, type PrDetails, type ReviewThread } from "../api";
import { categoryIcon, SEVERITY, VERDICT } from "../icons";
import { changesInRange, findFile, lineNumbers, testCodeLines } from "../diffUtils";
import { prRisk } from "../risk";
import { MergeStatus } from "./MergeStatus";
import { useElementWidth } from "../hooks";
import { GithubHtml, Markdown } from "./Markdown";
import { HARNESSES, useAgent, type HarnessId } from "../harness";

/** s0 = overview, d0 = PR description, c = claim, f = finding. */
export type OutlineKey = `s${number}` | `d${number}` | `f${number}` | `c${number}` | `u${number}` | `t${number}`;

export interface RunState {
  running: boolean;
  step: string;
  log: string[];
  error?: string;
}

interface Props {
  pr: PrDetails;
  bodyHtml?: string;
  analysis?: Analysis;
  analysisRaw?: string;
  analyzedAt?: number;
  run?: RunState;
  files: FileData[];
  /** The reviewer's own generated-file globs, compiled; left out of the test-to-code ratio. */
  generated: RegExp[];
  selected: OutlineKey;
  inReview: number[];
  /** Re-check results after new commits, by finding index. */
  checks?: Record<number, FindingCheck>;
  /** Dismissed, resolved or commented findings, by index. */
  states?: Record<number, FindingState>;
  onState: (finding: number, state: FindingState | null) => void;
  /** Review threads already on the PR. */
  threads?: ReviewThread[];
  /** The PR is yours: self-review wording and what's blocking merge. */
  ownPr?: boolean;
  /** The commit the analysis ran on. */
  analysisHead?: string;
  onEditDescription?: () => void;
  onThreadDraft?: (t: ReviewThread) => Promise<string>;
  onThreadReply?: (t: ReviewThread, body: string) => Promise<void>;
  onThreadResolve?: (t: ReviewThread, resolve: boolean) => Promise<void>;
  onSelect: (k: OutlineKey) => void;
  onOpenAnchor: (a: Anchor, finding: number | null) => void;
  onStart: () => void;
  onCancel: () => void;
  onToggleReview: (finding: number) => void;
  onAsk: (text: string) => void;
}

const CHECK: Record<CheckStatus, { label: string; tone: string }> = {
  fixed: { label: "Fixed", tone: "ok" },
  open: { label: "Still open", tone: "high" },
  changed: { label: "Partly fixed", tone: "high" },
  unclear: { label: "Unclear", tone: "muted" },
};

/** How a finding fared when it was re-checked after new commits. */
function CheckBadge({ check }: { check?: FindingCheck }) {
  if (!check) return null;
  const c = CHECK[check.status];
  return <span className={`check-badge check-${c.tone}`} title={check.note}>{c.label}</span>;
}

const STATE_LABEL: Record<FindingState["state"], string> = { dismissed: "Dismissed", resolved: "Resolved", commented: "Commented" };
const DISMISS_REASONS = ["Not a problem", "Won't fix", "Handled elsewhere"];

/** "Double-checked" and so on, naming the checker when another agent did it. */
function checkLabel(c: { status: string; by?: HarnessId }): string {
  const who = c.by ? HARNESSES[c.by].short : null;
  if (c.status === "confirmed") return who ? `Confirmed by ${who}` : "Double-checked";
  if (c.status === "changed") return who ? `Corrected by ${who}` : "Corrected by double-check";
  if (c.status === "disputed") return "Disputed";
  return "Not confirmed";
}

function StateBadge({ state }: { state?: FindingState }) {
  if (!state) return null;
  return <span className={`check-badge state-${state.state}`} title={state.reason}>{STATE_LABEL[state.state]}</span>;
}

/** Resolve, dismiss with a reason, or restore a finding. */
function FindingActions({ state, onState }: { state?: FindingState; onState: (s: FindingState | null) => void }) {
  const [choosing, setChoosing] = useState(false);
  const [other, setOther] = useState("");
  const dismiss = (reason: string) => {
    onState({ state: "dismissed", reason, at: Date.now() });
    setChoosing(false);
    setOther("");
  };
  if (state?.state === "dismissed" || state?.state === "resolved") {
    return (
      <div className={`check-note state-note-${state.state}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}><strong>{STATE_LABEL[state.state]}</strong>{state.reason ? `: ${state.reason}` : ""}</span>
        <button type="button" className="btn sm" onClick={() => onState(null)}><RotateCcw size={13} />Reopen</button>
      </div>
    );
  }
  if (choosing) {
    return (
      <div className="dismiss-box" role="group" aria-label="Why dismiss this finding?">
        <span className="muted" style={{ fontSize: 12 }}>Why dismiss it?</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {DISMISS_REASONS.map((r) => <button key={r} type="button" className="btn sm" onClick={() => dismiss(r)}>{r}</button>)}
        </div>
        <form style={{ display: "flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (other.trim()) dismiss(other.trim()); }}>
          <input className="set-input" style={{ flex: 1, minWidth: 0 }} placeholder="Another reason" aria-label="Another reason" value={other} onChange={(e) => setOther(e.target.value)} />
          <button type="submit" className="btn sm" disabled={!other.trim()}>Dismiss</button>
          <button type="button" className="btn sm" onClick={() => setChoosing(false)}>Cancel</button>
        </form>
      </div>
    );
  }
  return (
    <>
      <button type="button" className="btn" data-key="resolve" onClick={() => onState({ state: "resolved", at: Date.now() })}><BadgeCheck size={14} />Resolve</button>
      <button type="button" className="btn" data-key="dismiss" onClick={() => setChoosing(true)}><CircleSlash size={14} />Dismiss…</button>
    </>
  );
}

/** Reply to a review conversation (optionally drafted by Claude), and resolve or reopen it. */
function ThreadReply(p: {
  thread: ReviewThread;
  onDraft?: (t: ReviewThread) => Promise<string>;
  onReply: (t: ReviewThread, body: string) => Promise<void>;
  onResolve?: (t: ReviewThread, resolve: boolean) => Promise<void>;
}) {
  const agent = useAgent().short;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"draft" | "reply" | "resolve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: "draft" | "reply" | "resolve", f: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="thread-reply">
      <textarea className="set-input" rows={3} placeholder="Reply…" aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} disabled={!!busy} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {p.onDraft && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => act("draft", async () => setText(await p.onDraft!(p.thread)))}>
            {busy === "draft" ? <Loader size={13} className="spin" /> : <Sparkles size={13} />}{busy === "draft" ? "Drafting…" : `Draft reply with ${agent}`}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {p.onResolve && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => act("resolve", () => p.onResolve!(p.thread, !p.thread.isResolved))}>
            {p.thread.isResolved ? <RotateCcw size={13} /> : <BadgeCheck size={13} />}{p.thread.isResolved ? "Reopen conversation" : "Resolve conversation"}
          </button>
        )}
        <button type="button" className="btn sm primary" disabled={!!busy || !text.trim()} onClick={() => act("reply", async () => { await p.onReply(p.thread, text.trim()); setText(""); })}>
          {busy === "reply" ? "Posting…" : "Reply"}
        </button>
      </div>
      {error && <p className="selectable" style={{ margin: 0, color: "var(--crit)", fontSize: 12 }}>{error}</p>}
    </div>
  );
}

const unmentionedText = (n: number) => (n === 1 ? "1 change not in the description" : `${n} changes not in the description`);

const VERDICT_WORD: Record<string, string> = { implemented: "implemented", partial: "partly implemented", contradicted: "contradicted", missing: "missing" };

function ago(ts?: number) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

export function AnalysisView(p: Props) {
  const agent = useAgent().short;
  const [showVerified, setShowVerified] = useState(false);
  const [showUnmentioned, setShowUnmentioned] = useState(true);
  const [showMinor, setShowMinor] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showResolvedThreads, setShowResolvedThreads] = useState(false);
  // In narrow panes the list and the detail take turns instead of sitting side by side.
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const [showDetail, setShowDetail] = useState(false);
  const single = width > 0 && width < 700;
  const outlineWidth = width < 980 ? 260 : 300;
  const a = p.analysis;
  const select = (k: OutlineKey) => {
    p.onSelect(k);
    setShowDetail(true);
  };

  if (!a) {
    return <StartPanel {...p} />;
  }

  const problems = a.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict !== "implemented");
  const verified = a.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict === "implemented");
  const isDismissed = (i: number) => p.states?.[i]?.state === "dismissed";
  const live = a.findings.map((f, i) => ({ f, i })).filter(({ i }) => !isDismissed(i));
  const dismissed = a.findings.map((f, i) => ({ f, i })).filter(({ i }) => isDismissed(i));
  // Disputed findings go after the undisputed ones and don't count: two agents disagree on them.
  const major = live.filter(({ f }) => f.severity === "critical" || f.severity === "high").sort(outlineOrder);
  const minor = live.filter(({ f }) => f.severity === "medium" || f.severity === "low").sort(outlineOrder);
  const crit = live.filter(({ f }) => f.severity === "critical" && !isDisputed(f)).length;
  const high = live.filter(({ f }) => f.severity === "high" && !isDisputed(f)).length;

  /** Right-click actions for a finding in the outline. */
  const findingMenu = (k: OutlineKey) => {
    if (k[0] !== "f" || !a) return undefined;
    const i = Number(k.slice(1));
    const f = a.findings[i];
    const st = p.states?.[i]?.state;
    return contextMenu([
      { label: "Open", run: () => select(k) },
      { label: p.inReview.includes(i) ? "Remove from review" : "Add to review", run: () => p.onToggleReview(i), separatorBefore: true },
      st ? { label: "Reopen", run: () => p.onState(i, null) } : { label: "Resolve", run: () => p.onState(i, { state: "resolved", at: Date.now() }) },
      { label: `Ask ${agent}`, run: () => p.onAsk(`About finding ${i + 1} ("${f.title}"): `), separatorBefore: true },
      { label: "Copy title", run: () => copyText(f.title) },
      ...(p.ownPr ? [{ label: "Copy for agent", run: () => copyText(buildHandoffPrompt({ pr: p.pr, head: p.analysisHead, analysis: a, states: p.states, findings: [i], claims: false })) }] : []),
    ]);
  };
  const Row = ({ k, sub, Icon, tone, text, meta, check, state, disputed }: { k: OutlineKey; sub?: boolean; Icon: LucideIcon; tone: string; text: string; meta?: string; check?: FindingCheck; state?: FindingState; disputed?: boolean }) => (
    <button type="button" data-nav className={["row", sub && "sub", p.selected === k && "sel", (check?.status === "fixed" || state?.state === "resolved" || state?.state === "dismissed") && "fixed"].filter(Boolean).join(" ")} onClick={() => select(k)} onContextMenu={findingMenu(k)} title={text}>
      <Icon size={14} className={tone} />
      <span className="ellipsis" style={{ flex: 1 }}>{text}</span>
      {disputed && !state && <span className="check-badge check-high">Disputed</span>}
      {state ? <StateBadge state={state} /> : <CheckBadge check={check} />}
      {meta && <span className="rm">{meta}</span>}
    </button>
  );
  const Toggle = ({ open, text, onClick }: { open: boolean; text: string; onClick: () => void }) => (
    <button type="button" className="row" aria-expanded={open} onClick={onClick}>
      {open ? <ChevronDown size={14} className="tone-muted" /> : <ChevronRight size={14} className="tone-muted" />}
      <span className="muted">{text}</span>
    </button>
  );
  const Group = ({ title, meta }: { title: string; meta?: string }) => (
    <div className="gh" style={{ marginTop: 8 }}>
      <span style={{ flex: 1 }}>{title}</span>
      {meta && <span style={{ fontWeight: 400 }}>{meta}</span>}
    </div>
  );

  const outline = (
    <div className="side" style={{ width: single ? "100%" : outlineWidth, flexShrink: 0, borderRight: single ? 0 : "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 34, padding: "0 6px 0 12px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        {p.run?.running ? <Loader size={14} className="spin tone-accent" /> : <CircleCheck size={14} className="tone-ok" />}
        <span className="ellipsis muted" style={{ flex: 1, fontSize: 12 }}>{p.run?.running ? p.run.step : `Analyzed ${ago(p.analyzedAt)}`}</span>
        <button type="button" className="tb" aria-label="Filter the list" title="Filter the list"><Funnel size={14} /></button>
        <button type="button" className="tb" aria-label="Re-run analysis" title="Re-run analysis" onClick={p.onStart} disabled={p.run?.running}>
          <RefreshCw size={14} />
        </button>
      </div>
      <nav aria-label="Analysis outline" data-pane="outline" className="scroll" style={{ padding: "0 6px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
        <div style={{ height: 6 }} />
        <Row k="s0" Icon={LayoutDashboard} tone="tone-muted" text="Overview" />
        <Row k="d0" Icon={FileText} tone="tone-muted" text="PR description" />

        <Group title="Description check" meta={`${verified.length} of ${a.claims.length} match`} />
        {problems.map(({ c, i }) => (
          <Row key={i} k={`c${i}`} Icon={VERDICT[c.verdict]?.icon ?? Flag} tone={VERDICT[c.verdict]?.tone ?? ""} text={c.text} meta={String(i + 1)} />
        ))}
        {verified.length > 0 && (
          <Toggle open={showVerified} text={verified.length === 1 ? "1 claim matches the code" : `${verified.length} claims match the code`} onClick={() => setShowVerified(!showVerified)} />
        )}
        {showVerified && verified.map(({ c, i }) => <Row key={i} k={`c${i}`} sub Icon={VERDICT.implemented.icon} tone="tone-ok" text={c.text} meta={String(i + 1)} />)}
        {(a.unmentioned ?? []).length > 0 && (
          <Toggle open={showUnmentioned} text={unmentionedText(a.unmentioned!.length)} onClick={() => setShowUnmentioned(!showUnmentioned)} />
        )}
        {showUnmentioned && (a.unmentioned ?? []).map((u, i) => <Row key={i} k={`u${i}`} sub Icon={FileX} tone="tone-muted" text={u.text} />)}

        <Group title="Findings" meta={crit || high ? [crit && `${crit} critical`, high && `${high} high`].filter(Boolean).join(" · ") : `${a.findings.length}`} />
        {major.map(({ f, i }) => (
          <Row key={i} k={`f${i}`} Icon={SEVERITY[f.severity].icon} tone={SEVERITY[f.severity].tone} text={f.title} meta={String(i + 1)} check={p.checks?.[i]} state={p.states?.[i]} disputed={isDisputed(f)} />
        ))}
        {minor.length > 0 && (
          <Toggle open={showMinor} text={minor.length === 1 ? "1 medium or low finding" : `${minor.length} medium and low findings`} onClick={() => setShowMinor(!showMinor)} />
        )}
        {showMinor && minor.map(({ f, i }) => <Row key={i} k={`f${i}`} sub Icon={SEVERITY[f.severity].icon} tone={SEVERITY[f.severity].tone} text={f.title} meta={String(i + 1)} check={p.checks?.[i]} state={p.states?.[i]} disputed={isDisputed(f)} />)}
        {dismissed.length > 0 && (
          <Toggle open={showDismissed} text={dismissed.length === 1 ? "1 dismissed finding" : `${dismissed.length} dismissed findings`} onClick={() => setShowDismissed(!showDismissed)} />
        )}
        {showDismissed && dismissed.map(({ f, i }) => <Row key={i} k={`f${i}`} sub Icon={SEVERITY[f.severity].icon} tone="tone-muted" text={f.title} meta={String(i + 1)} state={p.states?.[i]} />)}

        {(p.threads ?? []).length > 0 && (() => {
          const all = (p.threads ?? []).map((t, i) => ({ t, i })).filter(({ t }) => t.comments.length);
          const open = all.filter(({ t }) => !t.isResolved);
          const resolved = all.filter(({ t }) => t.isResolved);
          const text = (t: ReviewThread) => `${t.comments[0].author}: ${t.comments[0].body.replace(/\s+/g, " ")}`;
          return (
            <>
              <Group title="Conversations" meta={open.length ? `${open.length} open` : "all resolved"} />
              {open.map(({ t, i }) => <Row key={i} k={`t${i}`} Icon={MessageSquare} tone="tone-accent" text={text(t)} meta={String(t.comments.length)} />)}
              {resolved.length > 0 && (
                <Toggle open={showResolvedThreads} text={resolved.length === 1 ? "1 resolved conversation" : `${resolved.length} resolved conversations`} onClick={() => setShowResolvedThreads(!showResolvedThreads)} />
              )}
              {showResolvedThreads && resolved.map(({ t, i }) => <Row key={i} k={`t${i}`} sub Icon={MessageSquare} tone="tone-muted" text={text(t)} meta={String(t.comments.length)} />)}
            </>
          );
        })()}
        {a.findings.length === 0 && <p className="muted" style={{ margin: "2px 10px", fontSize: 12 }}>No findings.</p>}
      </nav>
    </div>
  );
  const detail = (
    <article data-pane="content" className="scroll selectable" style={{ padding: single ? "14px 16px 24px" : "20px 28px 32px" }} aria-label="Details">
      <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 16 }}>
        <Detail {...p} analysis={a} onSelect={select} />
      </div>
    </article>
  );

  return (
    <div ref={rootRef} style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {!single && outline}
      {!single && detail}
      {single && !showDetail && outline}
      {single && showDetail && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", height: 34, padding: "0 8px", borderBottom: "1px solid var(--line)", background: "var(--side)", flexShrink: 0 }}>
            <button type="button" className="btn sm" onClick={() => setShowDetail(false)}><ArrowLeft size={13} />All results</button>
          </div>
          {detail}
        </div>
      )}
    </div>
  );
}

function Excerpt({ files, anchor, onOpen }: { files: FileData[]; anchor: Anchor; onOpen: () => void }) {
  const file = findFile(files, anchor.path);
  const changes = file ? changesInRange(file, anchor, 1) : [];
  return (
    <div className="excerpt">
      <div className="exh">
        <FileDiff size={14} className="tone-muted" />
        <span className="mono ellipsis" style={{ flex: 1 }} title={anchor.path}>{anchorLabel(anchor)}</span>
        <button type="button" className="btn sm" onClick={onOpen}><FileDiff size={13} />Open in Diff</button>
      </div>
      <div style={{ padding: "4px 0", background: "var(--bg)", overflowX: "auto" }}>
        {changes.length === 0 && <div className="muted" style={{ padding: "6px 12px", fontSize: 12 }}>These lines aren't part of the diff.</div>}
        {changes.map((c, i) => {
          const n = lineNumbers(c);
          const nl = Number(n.new);
          const hl = nl >= anchor.startLine && nl <= anchor.endLine;
          return (
            <div key={i} className={`dl ${c.type}${hl ? " hl" : ""}`}>
              <span className="n">{n.old}</span>
              <span className="n">{n.new}</span>
              <span>{c.type === "insert" ? "+" : c.type === "delete" ? "−" : ""}</span>
              <span className="t">{c.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DECISION: Record<Decision, { label: string; cls: string; icon: LucideIcon; tone: string }> = {
  request_changes: { label: "Request changes", cls: "verdict changes", icon: OctagonExclamationPoint, tone: "tone-crit" },
  comment: { label: "Comment, but no blockers", cls: "verdict", icon: MessageSquare, tone: "tone-accent" },
  approve: { label: "Looks ready to approve", cls: "verdict ok", icon: CircleCheck, tone: "tone-ok" },
};

/** The same decisions, worded for the author checking their own PR. */
const SELF_DECISION: Record<Decision, string> = {
  request_changes: "Fix these before asking for reviews",
  comment: "Worth another look before asking for reviews",
  approve: "Ready to ask for reviews",
};

const COVERED = {
  yes: { label: "Tested", tone: "tone-ok", Icon: CircleCheck },
  partly: { label: "Partly tested", tone: "tone-high", Icon: CircleDashed },
  no: { label: "Not tested", tone: "tone-crit", Icon: CircleX },
} as const;

/** How risky the change is (size, CI, sensitive areas) and whether its changes are tested. */
function RiskAndTests(p: Props & { analysis: Analysis }) {
  const a = p.analysis;
  const ci = p.pr.statusCheckRollup ?? [];
  const failing = ci.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.conclusion ?? c.state ?? ""));
  const risk = prRisk({
    additions: p.pr.additions,
    deletions: p.pr.deletions,
    ci: failing ? "FAILURE" : "SUCCESS",
    files: p.files.map((f) => (f.type === "delete" ? f.oldPath : f.newPath)),
  } as Parameters<typeof prRisk>[0]);
  const { test, code } = testCodeLines(p.files, p.generated);
  const ratio = code ? test / code : 0;
  const tests = a.tests ?? [];
  const untested = tests.filter((t) => t.covered !== "yes").length;
  if (!a.risks?.length && !tests.length && risk.level === "low" && !code) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 className="section-title">Risk and tests</h2>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span className={`risk risk-${risk.level}`} style={risk.level === "low" ? { color: "var(--ok)", background: "var(--ok-bg)" } : undefined}>
          {risk.level === "high" ? "High risk" : risk.level === "medium" ? "Medium risk" : "Low risk"}
        </span>
        {risk.reasons.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{risk.reasons.join(" · ")}</span>}
        {code > 0 && (
          <span className="muted" style={{ fontSize: 12 }} title={`${test} added test lines for ${code} added code lines`}>
            · {test === 0 ? "no test changes" : `${test.toLocaleString()} test lines for ${code.toLocaleString()} code lines (${ratio.toFixed(2)})`}
          </span>
        )}
      </div>
      {(a.risks ?? []).length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", margin: "0 -10px" }}>
          {a.risks!.map((r, i) => (
            <button key={i} type="button" className="attn" disabled={!r.anchors[0]} onClick={() => r.anchors[0] && p.onOpenAnchor(r.anchors[0], null)}>
              <ShieldAlert size={16} className="tone-high" />
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600 }}>{r.area}:</span> {r.why}</span>
              {r.anchors[0] && <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{anchorLabel(r.anchors[0])}</span>}
            </button>
          ))}
        </div>
      )}
      {tests.length > 0 && (
        <details className="tests-fold" open={untested > 0}>
          <summary className="muted" style={{ fontSize: 12, cursor: "default" }}>
            {untested ? `${untested} of ${tests.length} changes not fully tested` : `All ${tests.length} changes are tested`}
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {tests.map((t, i) => {
              const c = COVERED[t.covered];
              return (
                <div key={i} className="test-row">
                  <c.Icon size={15} className={c.tone} aria-label={c.label} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{t.change}</div>
                    {(t.note || t.tests.length > 0) && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {t.note}
                        {t.tests.length > 0 && <> {t.note ? "· " : ""}<code>{t.tests.join(", ")}</code></>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}

function Overview(p: Props & { analysis: Analysis }) {
  const a = p.analysis;
  const problems = a.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict !== "implemented");
  const major = a.findings
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => (f.severity === "critical" || f.severity === "high") && p.states?.[i]?.state !== "dismissed" && p.states?.[i]?.state !== "resolved" && !isDisputed(f));
  const count = (s: string) => a.findings.filter((f) => f.severity === s && !isDisputed(f)).length;
  const disputed = a.findings.filter(isDisputed);
  const disputedBy = disputed.find((f) => f.check?.by)?.check?.by;
  const derived: Decision = major.length || problems.some(({ c }) => c.verdict !== "partial") ? "request_changes" : a.findings.some((f) => !isDisputed(f)) || problems.length ? "comment" : "approve";
  const decision = DECISION[a.recommendation?.decision ?? derived];
  const matching = a.claims.length - problems.length;

  return (
    <>
      {p.ownPr && <MergeStatus pr={p.pr} threads={p.threads ?? []} />}
      <div className={decision.cls}>
        <decision.icon size={20} className={decision.tone} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{p.ownPr ? SELF_DECISION[a.recommendation?.decision ?? derived] : decision.label}</span>
          {a.recommendation?.reason && <span style={{ fontSize: 13 }}>{a.recommendation.reason}</span>}
        </div>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2 className="section-title">In short</h2>
        {a.summary ? <Markdown text={a.summary} /> : <p className="muted" style={{ margin: 0 }}>Re-run the analysis to get a plain-language summary.</p>}
        {a.guidelines && a.guidelines.length > 0 && (
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>Followed the repository's review guidelines: {a.guidelines.join(", ")}</p>
        )}
      </section>

      {a.verifyFailed && (
        <p className="check-note check-high" style={{ margin: 0 }}>
          <strong>Not double-checked: {HARNESSES[a.verifyFailed.by].short} couldn't run.</strong> {a.verifyFailed.error}
        </p>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="stat"><CircleCheck size={13} className={matching === a.claims.length ? "tone-ok" : "tone-high"} />{matching} of {a.claims.length} claims match the code</span>
        {(a.unmentioned ?? []).length > 0 && (
          <button type="button" className="stat" onClick={() => p.onSelect("u0")} title="Changes the description doesn't mention. Not necessarily problems.">
            <FileX size={13} className="tone-muted" />{unmentionedText(a.unmentioned!.length)}
          </button>
        )}
        {(["critical", "high", "medium", "low"] as const).map((s) => {
          const n = count(s);
          if (!n) return null;
          const sev = SEVERITY[s];
          return <span key={s} className="stat"><sev.icon size={13} className={sev.tone} />{n} {s}</span>;
        })}
        {disputed.length > 0 && <span className="stat"><CircleSlash size={13} className="tone-high" />{disputed.length} disputed{disputedBy ? ` by ${HARNESSES[disputedBy].short}` : ""}</span>}
        {a.findings.length === 0 && <span className="stat"><CircleCheck size={13} className="tone-ok" />No findings</span>}
      </div>
      {a.dropped && a.dropped.length > 0 && (
        <details className="muted" style={{ fontSize: 12 }}>
          <summary style={{ cursor: "default" }}>
            {a.dropped.length === 1 ? "1 finding was dropped after a double-check" : `${a.dropped.length} findings were dropped after a double-check`}
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {a.dropped.map((d, i) => (
              <li key={i}><span style={{ color: "var(--text)" }}>{d.finding.title}</span>{d.note ? `: ${d.note}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
      {a.repoDismissals && a.repoDismissals.length > 0 && (
        <details className="muted" style={{ fontSize: 12 }}>
          <summary style={{ cursor: "default" }}>
            {a.repoDismissals.length === 1 ? "Used 1 dismissal" : `Used ${a.repoDismissals.length} dismissals`} from other pull requests in this repository
          </summary>
          <p style={{ margin: "6px 0 0" }}>The same point in the same file isn't reported again unless it's clearly more serious here.</p>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {a.repoDismissals.map((d, i) => (
              <li key={i}>
                {d.pr && <span className="mono">{d.pr} </span>}<span style={{ color: "var(--text)" }}>{d.title}</span>
                {d.path && <span className="mono"> · {d.path.split("/").pop()}</span>}{d.reason ? `: ${d.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 className="section-title">Needs your attention</h2>
        {problems.length === 0 && major.length === 0 && (
          <p style={{ margin: 0 }}>Nothing above medium severity, and the description matches the code.</p>
        )}
        <div style={{ display: "flex", flexDirection: "column", margin: "0 -10px" }}>
          {major.map(({ f, i }) => {
            const sev = SEVERITY[f.severity];
            return (
              <button key={`f${i}`} type="button" className="attn" onClick={() => p.onSelect(`f${i}`)}>
                <sev.icon size={16} className={sev.tone} />
                <span style={{ flex: 1, minWidth: 0 }}>{f.title}</span>
                <CheckBadge check={p.checks?.[i]} />
                <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>Finding {i + 1}</span>
                <ChevronRight size={14} className="tone-muted" />
              </button>
            );
          })}
          {problems.map(({ c, i }) => {
            const v = VERDICT[c.verdict] ?? VERDICT.partial;
            return (
              <button key={`c${i}`} type="button" className="attn" onClick={() => p.onSelect(`c${i}`)}>
                <v.icon size={16} className={v.tone} />
                <span style={{ flex: 1, minWidth: 0 }}><span className={v.tone} style={{ fontWeight: 600 }}>{v.label}:</span> {c.text}</span>
                <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>Claim {i + 1}</span>
                <ChevronRight size={14} className="tone-muted" />
              </button>
            );
          })}
        </div>
      </section>

      <RiskAndTests {...p} />

      {/* The full description is one click away, so it stays folded here to keep the page short. */}
      <details className="excerpt fold">
        <summary>
          <ChevronRight size={14} className="fold-chev tone-muted" />
          <span style={{ flex: 1 }}>PR description by {p.pr.author.login}</span>
        </summary>
        <div style={{ padding: "4px 16px 12px" }}>
          <GithubHtml html={p.bodyHtml} fallback={p.pr.body} />
        </div>
      </details>
    </>
  );
}

function Detail(p: Props & { analysis: Analysis }) {
  const agent = useAgent().short;
  const a = p.analysis;
  const kind = p.selected[0];
  const idx = Number(p.selected.slice(1));

  if (kind === "t" && p.threads?.[idx]) {
    const t = p.threads[idx];
    const anchor = t.line ? { path: t.path, startLine: t.startLine ?? t.line, endLine: t.line } : null;
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={t.isResolved ? "check-badge state-resolved" : "check-badge state-commented"}>{t.isResolved ? "Resolved" : "Open"}</span>
          {t.isOutdated && <span className="tag">Outdated</span>}
          <span className="mono muted" style={{ fontSize: 12 }}>{t.path}{t.line ? `:${t.line}` : ""}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn sm" onClick={() => openUrl(t.comments[0]?.url ?? p.pr.url)}><ExternalLink size={13} />GitHub</button>
        </div>
        {anchor && !t.isOutdated && <Excerpt files={p.files} anchor={anchor} onOpen={() => p.onOpenAnchor(anchor, null)} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {t.comments.map((c, i) => (
            <div key={i} className="thread-comment">
              <div className="muted" style={{ fontSize: 12 }}><strong style={{ color: "var(--text)" }}>{c.author}</strong> · {ago(new Date(c.createdAt).getTime())}</div>
              <Markdown text={c.body} />
            </div>
          ))}
        </div>
        {p.onThreadReply && <ThreadReply key={t.id} thread={t} onDraft={p.onThreadDraft} onReply={p.onThreadReply} onResolve={p.onThreadResolve} />}
      </>
    );
  }

  if (kind === "d") {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 600 }}>PR description</h2>
          <span className="muted" style={{ fontSize: 12 }}>by {p.pr.author.login}</span>
          {p.ownPr && p.onEditDescription && <button type="button" className="btn sm" onClick={p.onEditDescription}><Sparkles size={13} />Edit with {agent}</button>}
          <button type="button" className="btn sm" onClick={() => openUrl(p.pr.url)}><ExternalLink size={13} />GitHub</button>
        </div>
        <GithubHtml html={p.bodyHtml} fallback={p.pr.body} />
      </>
    );
  }

  if (kind === "f" && a.findings[idx]) {
    const f = a.findings[idx];
    const sev = SEVERITY[f.severity];
    const Cat = categoryIcon(f.category);
    const inReview = p.inReview.includes(idx);
    const go = (d: number) => p.onSelect(`f${(idx + d + a.findings.length) % a.findings.length}`);
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className={`sev ${sev.tone}`}><sev.icon size={16} />{sev.label}</span>
          <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
            <Cat size={14} />{f.category}{f.confidence ? ` · ${f.confidence} confidence` : ""}
          </span>
          {f.notInDescription && <span className="tag"><FileX size={12} />Not in description</span>}
          {f.check && (
            <span className={`check-badge ${f.check.status === "confirmed" ? "check-ok" : f.check.status === "disputed" ? "check-high" : ""}`} title={f.check.note}>
              {checkLabel(f.check)}
            </span>
          )}
          <CheckBadge check={p.checks?.[idx]} />
          <StateBadge state={p.states?.[idx]} />
          <span style={{ flex: 1 }} />
          {/* One group, so a long header wraps as a whole instead of splitting the two arrows. */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
            <span className="muted" style={{ fontSize: 12 }}>Finding {idx + 1} of {a.findings.length}</span>
            <button type="button" className="tb" aria-label="Previous finding" onClick={() => go(-1)}><ChevronUp size={16} /></button>
            <button type="button" className="tb" aria-label="Next finding" onClick={() => go(1)}><ChevronDown size={16} /></button>
          </span>
        </div>
        {p.checks?.[idx] && (
          <p className={`check-note check-${CHECK[p.checks[idx].status].tone}`}>
            <strong>After the new commits:</strong> {p.checks[idx].note || CHECK[p.checks[idx].status].label}
          </p>
        )}
        {f.check?.status === "uncertain" && (
          <p className="check-note check-muted">
            <strong>A second pass couldn't confirm this:</strong> {f.check.note || "the code didn't settle it either way."}
          </p>
        )}
        {f.check?.status === "disputed" && (
          <p className="check-note check-high">
            <strong>{f.check.by ? HARNESSES[f.check.by].short : "The double-check"} disagrees with this finding:</strong> {f.check.note || "it found no support in the code."} You decide: it isn't counted or ticked for posting until you do.
          </p>
        )}
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>{f.title}</h2>
        <Markdown text={f.body} />
        {f.anchors[0] && <Excerpt files={p.files} anchor={f.anchors[0]} onOpen={() => p.onOpenAnchor(f.anchors[0], idx)} />}
        {f.fix && (
          <div className="fix">
            <Wrench size={16} className="tone-ok" style={{ marginTop: 3, flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <b>Suggested fix</b>
              <Markdown text={f.fix} />
              {f.suggestion && <pre className="suggestion-code" aria-label="Suggested replacement">{f.suggestion}</pre>}
            </div>
          </div>
        )}
        {f.anchors.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }} className="muted">
            Also in
            {f.anchors.slice(1).map((an, j) => (
              <button key={j} type="button" className="flink" title={an.path} onClick={() => p.onOpenAnchor(an, idx)}>{anchorLabel(an)}</button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 8, borderTop: "1px solid var(--line2)" }}>
          <button type="button" data-key="add-review" className={inReview ? "btn in-review" : "btn"} aria-pressed={inReview} onClick={() => p.onToggleReview(idx)}>
            {inReview ? <CircleCheck size={14} /> : <MessageSquarePlus size={14} />}{inReview ? "In review" : "Add to review"}
          </button>
          <button type="button" className="btn" onClick={() => p.onAsk(`About finding ${idx + 1} ("${f.title}"): `)}><MessageSquare size={14} />Ask {agent}</button>
          {p.states?.[idx]?.state !== "dismissed" && p.states?.[idx]?.state !== "resolved" && <FindingActions state={p.states?.[idx]} onState={(st) => p.onState(idx, st)} />}
        </div>
        {(p.states?.[idx]?.state === "dismissed" || p.states?.[idx]?.state === "resolved") && <FindingActions state={p.states?.[idx]} onState={(st) => p.onState(idx, st)} />}
      </>
    );
  }

  if (kind === "u" && a.unmentioned?.[idx]) {
    const u = a.unmentioned[idx];
    const n = a.unmentioned.length;
    const go = (d: number) => p.onSelect(`u${(idx + d + n) % n}`);
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="sev tone-muted"><FileX size={16} />Not in the description</span>
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12 }}>Change {idx + 1} of {n}</span>
          <button type="button" className="tb" aria-label="Previous change" onClick={() => go(-1)}><ChevronUp size={16} /></button>
          <button type="button" className="tb" aria-label="Next change" onClick={() => go(1)}><ChevronDown size={16} /></button>
        </div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>{u.text}</h2>
        <p className="muted" style={{ margin: 0 }}>The description doesn't mention this change. That doesn't make it a problem: check it's intended.</p>
        {u.anchors[0] && <Excerpt files={p.files} anchor={u.anchors[0]} onOpen={() => p.onOpenAnchor(u.anchors[0], null)} />}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {u.anchors.slice(1).map((an, j) => (
            <button key={j} type="button" className="flink" title={an.path} onClick={() => p.onOpenAnchor(an, null)}>{anchorLabel(an)}</button>
          ))}
          <button type="button" className="btn sm" onClick={() => p.onAsk(`About the change not in the description, "${u.text}": `)}><MessageSquare size={13} />Ask {agent}</button>
          <button type="button" className="btn sm" onClick={() => p.onSelect("d0")}><FileText size={13} />Read the full description</button>
        </div>
      </>
    );
  }

  if (kind === "c" && a.claims[idx]) {
    const c = a.claims[idx];
    const v = VERDICT[c.verdict] ?? VERDICT.partial;
    const fi = c.finding;
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className={`sev ${v.tone}`}><v.icon size={16} />{v.label}</span>
          {c.source && <span className="tag">From issue {c.source}</span>}
          {c.check && (
            <span className={`check-badge ${c.check.status === "confirmed" ? "check-ok" : ""}`} title={c.check.note}>
              {checkLabel(c.check)}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12 }}>Claim {idx + 1} of {a.claims.length}</span>
        </div>
        <div>
          <span className="section-title">{c.source ? `Issue ${c.source} asks for` : "The description says"}</span>
          <blockquote style={{ margin: "6px 0 0", padding: "6px 12px", borderLeft: "3px solid var(--line)", fontSize: 16, lineHeight: 1.5 }}>{c.text}</blockquote>
        </div>
        {c.check?.status === "changed" && (
          <p className="check-note check-muted">
            <strong>A second pass changed this from {VERDICT_WORD[c.check.previous ?? ""] ?? c.check.previous}:</strong> {c.check.note}
          </p>
        )}
        {c.check?.status === "uncertain" && (
          <p className="check-note check-muted">
            <strong>A second pass couldn't confirm this verdict:</strong> {c.check.note || "the code didn't settle it either way."}
          </p>
        )}
        {c.note && (
          <div>
            <span className="section-title">What the code does</span>
            <div style={{ marginTop: 6 }}><Markdown text={c.note} /></div>
          </div>
        )}
        {c.anchors[0] && <Excerpt files={p.files} anchor={c.anchors[0]} onOpen={() => p.onOpenAnchor(c.anchors[0], null)} />}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {c.anchors.slice(1).map((an, j) => (
            <button key={j} type="button" className="flink" title={an.path} onClick={() => p.onOpenAnchor(an, null)}>{anchorLabel(an)}</button>
          ))}
          {fi !== undefined && a.findings[fi] && (
            <button type="button" className="btn sm" onClick={() => p.onSelect(`f${fi}`)}><Flag size={13} />See finding {fi + 1}{isDisputed(a.findings[fi]) ? " (disputed)" : ""}</button>
          )}
          <button type="button" className="btn sm" onClick={() => p.onSelect("d0")}><FileText size={13} />Read the full description</button>
        </div>
      </>
    );
  }

  return <Overview {...p} />;
}

function StartPanel(p: Props) {
  const agent = useAgent().short;
  const run = p.run;
  return (
    <div className="scroll selectable" style={{ padding: "24px 28px", height: "100%" }}>
      <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 16 }}>
        {p.ownPr && <MergeStatus pr={p.pr} threads={p.threads ?? []} />}
        <div className="verdict" style={{ alignItems: "center" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{run?.running ? `Reviewing with ${agent}…` : p.ownPr ? "Review your own pull request" : "Start the review"}</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {run?.running
                ? run.step
                : p.ownPr
                  ? `Catch problems before reviewers do: ${agent} checks your description against the code and lists what to fix first. ${agent} can only read.`
                  : `Checks out the PR in its own worktree, then ${agent} compares the description with the code and lists what to look at. ${agent} can only read.`}
            </span>
          </div>
          {run?.running ? (
            <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>
          ) : (
            <button type="button" className="btn primary" onClick={p.onStart}><Play size={14} />{p.ownPr ? "Self-review" : "Start review"}</button>
          )}
        </div>
        {run?.error && <p style={{ margin: 0, color: "var(--crit)" }}>{run.error}</p>}
        {p.analysisRaw && !run?.running && (
          <details>
            <summary className="muted">{agent}'s last answer couldn't be read as a result. Show it</summary>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{p.analysisRaw}</pre>
          </details>
        )}
        {run && run.log.length > 0 && (
          <details open={run.running}>
            <summary className="muted" style={{ fontSize: 12 }}>What {agent} has done ({run.log.length})</summary>
            <div className="mono" style={{ marginTop: 6, padding: "8px 10px", borderRadius: 6, background: "var(--sunken)", fontSize: 11, lineHeight: 1.8, color: "var(--muted)", maxHeight: 240, overflow: "auto" }}>
              {run.log.map((l, i) => <div key={i} className="ellipsis">{l}</div>)}
            </div>
          </details>
        )}
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 className="section-title" style={{ flex: 1 }}>PR description by {p.pr.author.login}</h2>
            {p.ownPr && p.onEditDescription && <button type="button" className="btn sm" onClick={p.onEditDescription}><Sparkles size={13} />Edit with {agent}</button>}
            <button type="button" className="btn sm" onClick={() => openUrl(p.pr.url)}><ExternalLink size={13} />GitHub</button>
          </div>
          <div className="excerpt" style={{ padding: "12px 16px" }}>
            <GithubHtml html={p.bodyHtml} fallback={p.pr.body} />
          </div>
        </section>
      </div>
    </div>
  );
}
