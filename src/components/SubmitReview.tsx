import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ClipboardCopy, ExternalLink, Loader, MessageSquare, Send, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileData } from "react-diff-view";
import { anchorLabel, buildHandoffPrompt, startsTicked, type Analysis, type Finding, type FindingCheck, type FindingState } from "../analysis";
import { copyText } from "../contextMenu";
import { api, errorText, type PrDetails, type ReviewEvent } from "../api";
import { commentLines } from "../diffUtils";
import type { DraftComment } from "./DiffView";
import { SEVERITY } from "../icons";
import { useAgent } from "../harness";
import { bucket, track } from "../telemetry";

interface Props {
  repo: string;
  details: PrDetails;
  analysis?: Analysis;
  files: FileData[];
  /** Findings the user added to the review; when empty, critical and high findings start checked. */
  inReview: number[];
  /** GitHub doesn't let you approve or request changes on your own pull request. */
  ownPr: boolean;
  /** The commit the analysis ran on. */
  analysisHead?: string;
  /** Re-check results after new commits; fixed findings start unchecked. */
  checks?: Record<number, FindingCheck>;
  /** Dismissed, resolved or already-commented findings start unchecked. */
  states?: Record<number, FindingState>;
  onClose: () => void;
  onSubmitted: (url: string, postedFindings: number[]) => void;
  /** Comments written on selected diff lines. */
  drafts: DraftComment[];
  onDrafts: (d: DraftComment[]) => void;
  /** Asks Claude for a summary; absent until the PR has a worktree. */
  onDraftSummary?: (event: ReviewEvent, comments: Finding[], notes: string) => Promise<string>;
}

interface Item {
  index: number;
  finding: Finding;
  checked: boolean;
  text: string;
  where: ReturnType<typeof commentLines>;
  /** Post the finding's suggestion as a GitHub suggestion block. Only offered when it covers exactly the commented lines. */
  suggest: boolean;
  canSuggest: boolean;
}

/** A suggestion replaces exactly the commented lines, so it needs the comment on the anchor's full range. */
function suggestable(f: Finding, where: ReturnType<typeof commentLines>): boolean {
  const a = f.anchors[0];
  return !!(f.suggestion && a && where && a.startLine > 0 && where.line === a.endLine && (where.start_line ?? where.line) === a.startLine);
}

const EVENTS: [ReviewEvent, string][] = [
  ["COMMENT", "Comment"],
  ["APPROVE", "Approve"],
  ["REQUEST_CHANGES", "Request changes"],
];

function commentText(f: Finding): string {
  return `**${f.title}** (${SEVERITY[f.severity].label.toLowerCase()})\n\n${f.body}${f.fix ? `\n\n**Suggested fix:** ${f.fix}` : ""}`;
}

/** Posts a GitHub review, with the chosen findings as comments on their diff lines. */
export function SubmitReview(p: Props) {
  const agent = useAgent().short;
  const findings = p.analysis?.findings ?? [];
  const [items, setItems] = useState<Item[]>(() =>
    findings.map((finding, index) => ({
      index,
      finding,
      checked: startsTicked(finding, { fixed: p.checks?.[index]?.status === "fixed", hasState: !!p.states?.[index], inReview: p.inReview, index }),
      text: commentText(finding),
      where: finding.anchors.map((a) => commentLines(p.files, a)).find(Boolean) ?? null,
      suggest: false,
      canSuggest: false,
    })).map((i) => {
      const where = i.finding.anchors[0] ? commentLines(p.files, i.finding.anchors[0]) : null;
      const can = suggestable(i.finding, where);
      return can ? { ...i, where, canSuggest: true, suggest: true } : i;
    }),
  );
  const suggested: ReviewEvent = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" }[p.analysis?.recommendation?.decision ?? "comment"] as ReviewEvent;
  const [event, setEvent] = useState<ReviewEvent>(p.ownPr ? "COMMENT" : suggested);
  const [summary, setSummary] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = async () => {
    if (!p.onDraftSummary) return;
    setDrafting(true);
    setError(null);
    try {
      setSummary(await p.onDraftSummary(event, items.filter((i) => i.checked).map((i) => i.finding), summary));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !sending && p.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [p, sending]);

  const chosen = items.filter((i) => i.checked);
  const inline = chosen.filter((i) => i.where);
  const inBody = chosen.filter((i) => !i.where);
  const body = useMemo(
    () =>
      [summary.trim(), ...inBody.map((i) => `${i.text}${i.finding.anchors[0] ? `\n\n\`${anchorLabel(i.finding.anchors[0])}\`` : ""}`)]
        .filter(Boolean)
        .join("\n\n---\n\n"),
    [summary, inBody],
  );
  const empty = event !== "APPROVE" && !body && inline.length === 0 && p.drafts.length === 0;

  const allChecked = items.length > 0 && chosen.length === items.length;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && !allChecked;
  }, [chosen.length, allChecked]);

  const update = (index: number, change: Partial<Item>) =>
    setItems((all) => all.map((i) => (i.index === index ? { ...i, ...change } : i)));

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const url = await api.submitReview(p.repo, p.details.number, {
        commitId: p.details.headRefOid,
        event,
        body,
        comments: [...p.drafts.map((d) => ({ path: d.path, line: d.line, ...(d.start_line ? { start_line: d.start_line } : {}), body: d.body })), ...inline.map((i) => ({ ...i.where!, body: i.suggest && i.canSuggest ? `${i.text}\n\n\`\`\`suggestion\n${i.finding.suggestion}\n\`\`\`` : i.text }))],
      });
      track("review_submitted", { event, comments: bucket(inline.length + p.drafts.length), findings_posted: bucket(chosen.length), has_summary: !!summary.trim() });
      p.onSubmitted(url, chosen.map((i) => i.index));
    } catch (e) {
      setError(errorText(e));
      setSending(false);
    }
  };

  /** Nothing checked and every claim matches: the prompt would only have the closing instruction. */
  const nothingToHandOff = !chosen.length && !(p.analysis?.claims ?? []).some((c) => c.verdict !== "implemented");
  /** On your own PR the fix usually happens in your coding agent, not in a comment. */
  const copyForAgent = () => {
    if (!p.analysis) return;
    copyText(buildHandoffPrompt({ pr: p.details, head: p.analysisHead, analysis: p.analysis, states: p.states, findings: chosen.map((i) => i.index), claims: true }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const action = EVENTS.find(([e]) => e === event)![1];
  return (
    <div className="palette-backdrop" onMouseDown={() => !sending && p.onClose()}>
      <div className="dialog review-dialog" role="dialog" aria-label="Submit review" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 8px 10px 16px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ flex: 1, fontWeight: 600 }}>Submit review</span>
          <button type="button" className="tb" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openUrl(`${p.details.url}/files`)}><ExternalLink size={15} /></button>
          <button type="button" className="tb" aria-label="Close" onClick={p.onClose} disabled={sending}><X size={15} /></button>
        </div>

        <div className="review-body">
          {findings.length > 0 ? (
            <>
              <div className="review-head">
                <label className="review-all">
                  <input
                    ref={selectAll}
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => setItems((all) => all.map((i) => ({ ...i, checked: e.target.checked })))}
                  />
                  Comment on all {items.length} findings
                </label>
                <span className="muted">{inline.length} on lines{inBody.length ? `, ${inBody.length} in the summary` : ""}</span>
              </div>
              {items.map((i) => {
                const sev = SEVERITY[i.finding.severity];
                const Icon = sev.icon;
                return (
                  <div key={i.index} className={i.checked ? "review-item on" : "review-item"}>
                    <label className="review-item-head">
                      <input type="checkbox" checked={i.checked} onChange={(e) => update(i.index, { checked: e.target.checked })} />
                      <Icon size={14} className={sev.tone} aria-label={sev.label} />
                      <span className="ellipsis" style={{ flex: 1 }}>{i.finding.title}</span>
                      {p.checks?.[i.index]?.status === "fixed" && <span className="check-badge check-ok" title={p.checks[i.index].note}>Fixed</span>}
                      {p.states?.[i.index] && <span className={`check-badge state-${p.states[i.index].state}`} title={p.states[i.index].reason}>{{ dismissed: "Dismissed", resolved: "Resolved", commented: "Commented" }[p.states[i.index].state]}</span>}
                      <span className="muted review-where">
                        {i.where ? `${i.where.path.split("/").pop()}:${i.where.start_line ? `${i.where.start_line}–` : ""}${i.where.line}` : "Not on a changed line"}
                      </span>
                    </label>
                    {i.checked && (
                      <>
                        <textarea className="set-input" rows={4} value={i.text} aria-label={`Comment for ${i.finding.title}`} onChange={(e) => update(i.index, { text: e.target.value })} />
                        {!i.where && <p className="muted review-note">GitHub only takes comments on lines in the diff, so this goes in the review summary.</p>}
                        {i.canSuggest && (
                          <label className="review-suggest">
                            <input type="checkbox" checked={i.suggest} onChange={(e) => update(i.index, { suggest: e.target.checked })} />
                            <span>Add the fix as a suggestion the author can apply</span>
                          </label>
                        )}
                        {i.canSuggest && i.suggest && <pre className="suggestion-code" aria-label="Suggested change">{i.finding.suggestion}</pre>}
                      </>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>No findings to comment on. You can still leave a summary and a decision.</p>
          )}

          {p.drafts.length > 0 && (
            <>
              <div className="review-head" style={{ marginTop: 8 }}><span>Your comments</span><span className="muted">{p.drafts.length} on lines</span></div>
              {p.drafts.map((d, i) => (
                <div key={i} className="review-item on">
                  <div className="review-item-head">
                    <MessageSquare size={14} className="tone-accent" />
                    <span className="mono ellipsis" style={{ flex: 1 }}>{d.path}:{d.start_line ? `${d.start_line}–` : ""}{d.line}</span>
                    <button type="button" className="tb" aria-label="Remove comment" onClick={() => p.onDrafts(p.drafts.filter((_, j) => j !== i))}><X size={13} /></button>
                  </div>
                  <textarea className="set-input" rows={2} value={d.body} aria-label={`Comment on ${d.path}`} onChange={(e) => p.onDrafts(p.drafts.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
                </div>
              ))}
            </>
          )}

          <div className="review-head" style={{ marginTop: 8, alignItems: "center" }}>
            <span>Summary</span>
            {p.onDraftSummary && (
              <button type="button" className="btn sm" onClick={draft} disabled={drafting || sending} title={`${agent} writes a summary from your decision and comments; you can edit it`}>
                {drafting ? <Loader size={13} className="spin" /> : <Sparkles size={13} />}{drafting ? "Drafting…" : summary.trim() ? `Redraft with ${agent}` : `Draft with ${agent}`}
              </button>
            )}
          </div>
          <textarea className="set-input" rows={3} placeholder="Overall feedback (optional)" value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Review summary" />
        </div>

        <div className="review-foot">
          <div className="seg" role="radiogroup" aria-label="Review decision">
            {EVENTS.map(([e, label]) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={event === e}
                className={event === e ? "on" : ""}
                disabled={p.ownPr && e !== "COMMENT"}
                title={p.ownPr && e !== "COMMENT" ? "GitHub doesn't allow this on your own pull request" : undefined}
                onClick={() => setEvent(e)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* One group, so in a narrow window the buttons wrap together. */}
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            {p.ownPr && p.analysis && (
              <button
                type="button"
                className="btn"
                onClick={copyForAgent}
                disabled={sending || nothingToHandOff}
                title={nothingToHandOff ? "Check a finding first" : "Copy the checked findings as a prompt for your coding agent"}
              >
                {copied ? <Check size={14} className="tone-ok" /> : <ClipboardCopy size={14} />}{copied ? "Copied" : "Copy for agent"}
              </button>
            )}
            <button type="button" className="btn" onClick={p.onClose} disabled={sending}>Cancel</button>
            <button type="button" className="btn primary" onClick={submit} disabled={sending || empty} title={empty ? "Add a comment or a summary first" : undefined}>
              <Send size={14} />{sending ? "Posting…" : action}
            </button>
          </div>
        </div>
        {error && <p className="selectable review-error">{error}</p>}
      </div>
    </div>
  );
}
