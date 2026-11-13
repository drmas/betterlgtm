import { Check, ChevronDown, ChevronRight, Columns2, Files, Loader, Rows3, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Decoration, Diff, Hunk, getChangeKey, type FileData, type HunkData, type RenderGutter } from "react-diff-view";
import { anchorLabel, probeKey, probeOutcome, probeProgress, type Anchor, type Finding, type ProbeAnswer, type WalkStep } from "../analysis";
import { allReviewed, changesInRange, filePath, fileStats, findFile, hiddenKind, hunkKey, hunksForRanges, type HideRules } from "../diffUtils";
import { useTokens } from "../highlightAsync";
import { useElementWidth } from "../hooks";
import { fileIcon } from "../icons";
import { DiffModeSwitch, type DiffMode } from "./DiffView";
import { Markdown } from "./Markdown";
import { useAgent } from "../harness";

interface Props {
  files: FileData[];
  steps?: WalkStep[];
  findings: Finding[];
  current: number;
  reviewed: Set<string>;
  split: boolean;
  generating?: { running: boolean; error?: string };
  canGenerate: boolean;
  onSplit: (split: boolean) => void;
  onMode: (m: DiffMode) => void;
  /** Reports the section in view, so the chat context follows the scroll. Sections without changes are left out
   * here, so the index can differ from the walkthrough's: the step itself says which one it is. */
  onStep: (i: number, step: WalkStep) => void;
  onReviewed: (hunkKeys: string[], reviewed: boolean) => void;
  onGenerate: () => void;
  /** Generated and test files to leave out of the sections and the progress count. */
  hide: HideRules;
  /** Ask a step's predict-first question before its explanation. */
  predict: boolean;
  answers?: Record<string, ProbeAnswer>;
  onAnswer: (key: string, a: ProbeAnswer) => void;
  /** Opens the chat, which follows the section in view. */
  onAsk: () => void;
  onOpenAnchor: (a: Anchor) => void;
}

/** A step's predict-first question, then the answer from the code once it's answered or skipped. */
function ProbeCard({ step, answer, agent, onAnswer, onAsk, onOpenAnchor }: { step: WalkStep; answer?: ProbeAnswer; agent: string; onAnswer: (a: ProbeAnswer) => void; onAsk: () => void; onOpenAnchor: (a: Anchor) => void }) {
  const probe = step.probe!;
  const outcome = probeOutcome(probe, answer);
  // Picking a choice removes the button that had focus; move it to the answer so the keyboard isn't lost.
  const revealRef = useRef<HTMLDivElement>(null);
  const before = useRef(outcome);
  useEffect(() => {
    if (before.current === "open" && outcome !== "open") revealRef.current?.focus();
    before.current = outcome;
  }, [outcome]);
  const pick = (choice: ProbeAnswer["choice"]) => onAnswer({ choice, at: Date.now() });
  if (outcome === "open") {
    return (
      <div className="probe" role="group" aria-label="Predict before reading">
        <div className="probe-q">{probe.question}</div>
        <div className="probe-choices">
          {probe.choices.map((c, i) => <button key={i} type="button" className="btn" onClick={() => pick(i)}>{c}</button>)}
          <button type="button" className="btn" onClick={() => pick("unsure")}>Not sure</button>
        </div>
        <button type="button" className="btn sm probe-skip" onClick={() => pick("skipped")}>Show me</button>
      </div>
    );
  }
  const right = probe.choices[probe.answer];
  const head = outcome === "right" ? <><strong>You were right:</strong> {right}</> : <><strong>The code does:</strong> {right}{outcome === "wrong" && typeof answer?.choice === "number" ? <span className="muted"> (you picked: {probe.choices[answer.choice]})</span> : null}</>;
  return (
    <div ref={revealRef} tabIndex={-1} className={`probe probe-${outcome === "right" ? "right" : outcome === "wrong" ? "wrong" : "shown"}`} role="group" aria-label="Answer from the code">
      <div className="probe-q">{probe.question}</div>
      <div>{head}</div>
      {probe.why && <div>{probe.why}</div>}
      <div className="probe-foot">
        {probe.evidence && <button type="button" className="flink" title={probe.evidence.path} onClick={() => onOpenAnchor(probe.evidence!)}>{anchorLabel(probe.evidence)}</button>}
        <span className="muted">Read from the code, not run.</span>
        {(outcome === "wrong" || outcome === "unsure") && <button type="button" className="btn sm" onClick={onAsk}>Ask {agent} about this</button>}
      </div>
    </div>
  );
}

interface FilePart {
  file: FileData;
  hunks: HunkData[];
  keys: string[];
}

interface Step extends WalkStep {
  parts: FilePart[];
  keys: string[];
}

/** Resolves each step's line ranges to diff hunks, and adds a final section for anything left over. */
function resolveSteps(steps: WalkStep[], files: FileData[]): Step[] {
  const used = new Set<HunkData>();
  const part = (file: FileData, hunks: HunkData[]): FilePart => ({ file, hunks, keys: hunks.map((h) => hunkKey(file, h)) });
  const build = (s: WalkStep, parts: FilePart[]): Step => ({ ...s, parts, keys: parts.flatMap((x) => x.keys) });

  const out = steps.map((s) => {
    const byFile = new Map<FileData, Anchor[]>();
    for (const r of s.changes) {
      const f = findFile(files, r.path);
      if (f) byFile.set(f, [...(byFile.get(f) ?? []), r]);
    }
    const parts = [...byFile.entries()]
      .map(([file, ranges]) => part(file, hunksForRanges(file, ranges).filter((h) => !used.has(h))))
      .filter((x) => x.hunks.length > 0);
    parts.forEach((x) => x.hunks.forEach((h) => used.add(h)));
    return build(s, parts);
  });
  const rest = files.map((file) => part(file, file.hunks.filter((h) => !used.has(h)))).filter((x) => x.hunks.length > 0);
  if (rest.length) out.push(build({ title: "Other changes", why: "- Changes that weren't grouped into a step", changes: [] }, rest));
  return out.filter((s) => s.parts.length > 0);
}

function StepFile(p: { part: FilePart; findings: Finding[]; split: boolean; reviewed: boolean; onToggle: (v: boolean) => void }) {
  const { part } = p;
  const path = filePath(part.file);
  const Icon = fileIcon(path);
  const s = fileStats(part.file);
  // Reviewed files fold away, like GitHub's "Viewed", so the remaining work stays in view.
  const [open, setOpen] = useState(!p.reviewed);
  useEffect(() => setOpen(!p.reviewed), [p.reviewed]);

  // Everything shown already belongs to the section, so lines aren't highlighted; only finding markers stand out.
  const markers = useMemo(() => {
    const m = new Map<string, number>();
    p.findings.forEach((f, i) =>
      f.anchors.forEach((a) => {
        if (findFile([part.file], a.path) !== part.file) return;
        const first = changesInRange(part.file, a)[0];
        if (first && !m.has(getChangeKey(first))) m.set(getChangeKey(first), i + 1);
      }),
    );
    return m;
  }, [part, p.findings]);
  const tokens = useTokens(part.hunks, path, open);
  const renderGutter: RenderGutter = ({ change, side, renderDefault }) => {
    const n = markers.get(getChangeKey(change));
    return (
      <>
        {n !== undefined && side === (p.split ? "new" : "old") && <span className="mk" title={`Finding ${n}`}>{n}</span>}
        {renderDefault()}
      </>
    );
  };

  return (
    <div className={p.reviewed ? "excerpt part-done" : "excerpt"}>
      <div className="exh">
        <button type="button" className="tb" style={{ width: 22, height: 22 }} aria-expanded={open} aria-label={open ? "Fold file" : "Show file"} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Icon size={14} className="tone-muted" />
        <span className="mono ellipsis" style={{ flex: 1 }} title={path}>{path}</span>
        <span className="mono muted" style={{ fontSize: 11 }}>+{s.add} −{s.del}</span>
        <label className={p.reviewed ? "review-check on" : "review-check"}>
          <input type="checkbox" checked={p.reviewed} onChange={(e) => p.onToggle(e.target.checked)} />
          Reviewed
        </label>
      </div>
      {open && (
        <div style={{ overflowX: "auto" }}>
          <Diff viewType={p.split ? "split" : "unified"} diffType={part.file.type} hunks={part.hunks} tokens={tokens ?? undefined} renderGutter={renderGutter}>
            {(hunks) =>
              hunks.flatMap((h) => [
                <Decoration key={`d-${h.content}`}><span>{h.content}</span></Decoration>,
                <Hunk key={`h-${h.content}`} hunk={h} />,
              ])
            }
          </Diff>
        </div>
      )}
    </div>
  );
}

export function GuidedReview(p: Props) {
  const agent = useAgent().short;
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 700;
  const canSplit = width === 0 || width >= 900;
  const split = p.split && canSplit;
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const navItems = useRef<(HTMLDivElement | null)[]>([]);
  // Generated files (lockfiles, build output, the reviewer's own globs) and, by default, tests aren't
  // part of any section, so they never need opening or marking reviewed. The Files view still shows them.
  const { shown, hiddenGenerated, hiddenTests } = useMemo(() => {
    const kinds = p.files.map((f) => hiddenKind(f, p.hide));
    return {
      shown: p.files.filter((_, i) => !kinds[i]),
      hiddenGenerated: kinds.filter((k) => k === "generated").length,
      hiddenTests: kinds.filter((k) => k === "test").length,
    };
  }, [p.files, p.hide]);
  const hidden = hiddenGenerated + hiddenTests;
  const hiddenLabel = [
    hiddenGenerated && `${hiddenGenerated} generated`,
    hiddenTests && `${hiddenTests} test`,
  ].filter(Boolean).join(" and ") + ` ${hidden === 1 ? "file" : "files"} left out`;
  const steps = useMemo(() => (p.steps ? resolveSteps(p.steps, shown) : []), [p.steps, shown]);
  const [active, setActive] = useState(Math.min(p.current, Math.max(steps.length - 1, 0)));
  // Report the starting section too, not only scrolls and jumps: the chat context reads it before any scroll.
  useEffect(() => {
    if (steps[active]) p.onStep(active, steps[active]);
  }, [steps]);

  const stepDone = (s: Step) => allReviewed(s.keys, p.reviewed);
  const partsDone = (s: Step) => s.parts.filter((x) => allReviewed(x.keys, p.reviewed)).length;
  const doneSteps = steps.filter(stepDone).length;
  const asked = p.predict ? probeProgress(steps, p.answers) : { answered: 0, skipped: 0, total: 0 };
  const allKeys = steps.flatMap((s) => s.keys);
  const pct = allKeys.length ? Math.round((allKeys.filter((k) => p.reviewed.has(k)).length / allKeys.length) * 100) : 0;

  const jumpTo = (i: number) => {
    const el = sections.current[i];
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 8 });
    setActive(i);
    p.onStep(i, steps[i]);
  };

  // Scroll spy: the section whose top has passed the top edge is the one being read.
  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    let idx = 0;
    sections.current.forEach((el, i) => {
      if (el && el.offsetTop - sc.scrollTop <= 48) idx = i;
    });
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) idx = steps.length - 1;
    if (idx !== active) {
      setActive(idx);
      p.onStep(idx, steps[idx]);
    }
  };

  // Open where the user left off.
  useLayoutEffect(() => {
    if (p.current > 0 && steps.length) {
      const el = sections.current[Math.min(p.current, steps.length - 1)];
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 8;
    }
    // Only once steps exist; after that the position comes from scrolling.
  }, [steps.length > 0]);

  // Jumps requested from outside (the command palette) scroll to that section.
  useEffect(() => {
    if (steps.length && p.current !== active && p.current < steps.length) jumpTo(p.current);
  }, [p.current]);

  // Keep the active item visible in the side menu as the diff scrolls.
  useEffect(() => {
    navItems.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 8px 0 12px", borderBottom: "1px solid var(--line)", background: "var(--side)", flexShrink: 0 }}>
      <DiffModeSwitch mode="guided" onMode={p.onMode} compact={narrow} />
      {narrow && steps.length > 0 ? (
        <select
          aria-label="Jump to section"
          value={active}
          onChange={(e) => jumpTo(Number(e.target.value))}
          style={{ flex: 1, minWidth: 0, height: 24, fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 5 }}
        >
          {steps.map((s, i) => <option key={i} value={i}>{stepDone(s) ? "✓ " : ""}{i + 1}. {s.title}</option>)}
        </select>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      {narrow && asked.total > 0 && (
        <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} title={`${asked.answered} answered, ${asked.skipped} skipped`}>
          {asked.answered + asked.skipped} of {asked.total} asked
        </span>
      )}
      {hidden > 0 && !narrow && (
        <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} title="Generated files and tests are left out, as set in Settings → Review. The Files view shows them.">
          {hiddenLabel}
        </span>
      )}
      <div className="seg" role="group" aria-label="Diff layout">
        <button type="button" className={split ? "" : "on"} aria-pressed={!split} title="Unified" onClick={() => p.onSplit(false)}><Rows3 size={13} />{!narrow && "Unified"}</button>
        <button type="button" className={split ? "on" : ""} aria-pressed={split} disabled={!canSplit} title={canSplit ? "Split" : "Make the window wider to use split view"} onClick={() => p.onSplit(true)}><Columns2 size={13} />{!narrow && "Split"}</button>
      </div>
    </div>
  );

  if (!steps.length) {
    return (
      <div ref={rootRef} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {toolbar}
        <div className="empty">
          <div style={{ maxWidth: 380, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <Sparkles size={32} strokeWidth={1.4} className="tone-accent" />
            <h2 style={{ margin: 0, fontSize: 15, color: "var(--text)" }}>Guided review</h2>
            <p style={{ margin: 0 }}>{agent} groups related changes across files into sections, explains each one, and orders them so each builds on the last.</p>
            {p.steps && hidden > 0 ? (
              <span>Every changed file is generated or a test, so there's nothing to walk through here.</span>
            ) : p.generating?.running ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Loader size={14} className="spin" />Grouping the changes…</span>
            ) : p.canGenerate ? (
              <button type="button" className="btn primary" onClick={p.onGenerate}><Sparkles size={14} />Create guided review</button>
            ) : (
              <span>Start the review in the Analysis tab first.</span>
            )}
            {p.generating?.error && <span style={{ color: "var(--crit)" }}>{p.generating.error}</span>}
            <button type="button" className="btn sm" onClick={() => p.onMode("files")}><Files size={13} />Show all files instead</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {!narrow && (
        <nav aria-label="Review sections" data-pane="outline" className="side" style={{ width: width < 1000 ? 240 : 280, flexShrink: 0, borderRight: "1px solid var(--line)" }}>
          <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "flex", fontSize: 12, fontWeight: 600 }} className="muted">
              <span style={{ flex: 1 }}>{doneSteps} of {steps.length} sections reviewed{asked.total ? ` · ${asked.answered} answered, ${asked.skipped} skipped` : ""}</span>
              <span style={{ fontWeight: 400 }}>{pct}%</span>
            </div>
            <div role="progressbar" aria-label="Review progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 3, borderRadius: 2, background: "var(--line)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: 3, background: "var(--ok)" }} />
            </div>
          </div>
          <div className="scroll" style={{ padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {steps.map((s, i) => {
              const d = stepDone(s);
              const pd = partsDone(s);
              return (
                <div key={i} ref={(el) => { navItems.current[i] = el; }} className={i === active ? "step-row cur" : "step-row"}>
                  <label className="step-check" title={d ? "Mark as not reviewed" : "Mark section reviewed"}>
                    <input type="checkbox" checked={d} aria-label={`Section ${i + 1} reviewed`} onChange={(e) => p.onReviewed(s.keys, e.target.checked)} />
                    <span className={d ? "step-num done" : pd > 0 ? "step-num partial" : "step-num"}>{d ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
                  </label>
                  <button type="button" data-nav aria-current={i === active} className="step-go" onClick={() => jumpTo(i)}>
                    <span className="step-title">{s.title}</span>
                    <span className="step-meta">
                      {d ? "Reviewed" : pd > 0 ? `${pd} of ${s.parts.length} files reviewed` : `${s.parts.length} ${s.parts.length === 1 ? "file" : "files"}`}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </nav>
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {toolbar}
        <div ref={scroller} data-pane="content" className={narrow ? "scroll g-scroll g-narrow" : "scroll g-scroll"} onScroll={onScroll}>
          {steps.map((step, si) => {
            const done = stepDone(step);
            const filesDone = partsDone(step);
            return (
              <section key={si} ref={(el) => { sections.current[si] = el; }} aria-label={`Section ${si + 1}: ${step.title}`} className="g-section">
                <div className="g-head">
                  <span className={done ? "step-num done" : filesDone > 0 ? "step-num partial" : "step-num"}>{done ? <Check size={11} strokeWidth={3} /> : si + 1}</span>
                  <h2 className="ellipsis" title={step.title}>{step.title}</h2>
                  <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{done ? "Reviewed" : `${filesDone}/${step.parts.length} files`}</span>
                  <label className={done ? "review-check on" : "review-check"}>
                    <input type="checkbox" checked={done} data-review-toggle={si === active ? "" : undefined} onChange={(e) => p.onReviewed(step.keys, e.target.checked)} />
                    {!narrow && "Section reviewed"}
                  </label>
                </div>
                <div className="selectable" style={{ maxWidth: 760, padding: "2px 0 10px" }}>
                  {p.predict && step.probe && (
                    <ProbeCard step={step} answer={p.answers?.[probeKey(step)]} agent={agent} onAnswer={(a) => p.onAnswer(probeKey(step), a)} onAsk={() => { if (si !== active) jumpTo(si); p.onAsk(); }} onOpenAnchor={p.onOpenAnchor} />
                  )}
                  {/* The explanation waits until the question is answered or skipped. */}
                  {!(p.predict && step.probe && probeOutcome(step.probe, p.answers?.[probeKey(step)]) === "open") && <Markdown text={step.why} />}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {step.parts.map((part, i) => (
                    <StepFile
                      key={i}
                      part={part}
                      findings={p.findings}
                      split={split}
                      reviewed={allReviewed(part.keys, p.reviewed)}
                      onToggle={(v) => p.onReviewed(part.keys, v)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
