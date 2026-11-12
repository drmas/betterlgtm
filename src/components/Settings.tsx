import { Building2, CircleCheck, CircleX, Cpu, FolderCog, RefreshCw, SlidersHorizontal, Sparkles, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText, type ReviewRequest } from "../api";
import { HARNESSES, HARNESS_IDS, harnessOf, type HarnessId } from "../harness";
import { comboLabel } from "../commands";
import { DEFAULT_SETTINGS, ZOOM_STEPS, type Settings as S } from "../settings";

export type SettingsSection = "general" | "orgs" | "review" | "claude" | "tools";

interface Props {
  settings: S;
  update: (patch: Partial<S>) => void;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  orgs: { login: string; orgs: string[] } | null;
  orgsError: string | null;
  requests: ReviewRequest[] | null;
  onReloadOrgs: () => void;
  onClearData: () => void;
  /** Absent in the separate Settings window, which closes like any window. */
  onClose?: () => void;
}

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "orgs", label: "Organizations", icon: Building2 },
  { id: "review", label: "Review", icon: CircleCheck },
  { id: "claude", label: "Agent", icon: Sparkles },
  { id: "tools", label: "Tools & storage", icon: FolderCog },
];

/** How the zoom shortcuts read on this platform: ⌘= and ⌘- on macOS. */
const zoomKeys = `${comboLabel({ key: "=", ctrl: true })} and ${comboLabel({ key: "-", ctrl: true })}`;

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label"><span>{label}</span>{hint && <span>{hint}</span>}</div>
      {children}
    </div>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="set-row" style={{ cursor: "default" }}>
      <div className="set-label"><span>{label}</span>{hint && <span>{hint}</span>}</div>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0, accentColor: "var(--accent)" }} />
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/** Text field that saves when you leave it or press Enter, so half-typed paths aren't used. */
function TextSetting({ value, placeholder, onSave, mono }: { value: string; placeholder?: string; onSave: (v: string) => void; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={mono ? "set-input mono" : "set-input"}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Which agent double-checks: the reviewing agent, or another installed one. Names where the code goes and the agent's limits. */
function VerifyWith(p: Props) {
  const s = p.settings;
  const main = harnessOf(s);
  const [installed, setInstalled] = useState<HarnessId[] | null>(null);
  useEffect(() => {
    api.toolStatus().then((t) => setInstalled((t.agents ?? []).filter((a) => a.file).map((a) => a.id as HarnessId))).catch(() => setInstalled([]));
  }, []);
  const others = HARNESS_IDS.filter((id) => id !== main.id && (installed?.includes(id) || id === s.verifyWith));
  const other = s.verifyWith !== "same" && s.verifyWith !== main.id ? HARNESSES[s.verifyWith] : null;
  return (
    <Row
      label="Double-check with"
      hint={other ? <>{other.maker !== main.maker && <>Findings and code are also sent to {other.maker} ({other.name}). </>}{other.limits}</> : "The agent that ran the review checks its own findings"}
    >
      <select className="set-input" aria-label="Double-check with" value={other ? other.id : "same"} onChange={(e) => p.update({ verifyWith: e.target.value as HarnessId | "same" })}>
        <option value="same">Same agent</option>
        {others.map((id) => <option key={id} value={id}>{HARNESSES[id].name}</option>)}
      </select>
    </Row>
  );
}

function Organizations(p: Props) {
  const s = p.settings;
  const counts = new Map<string, number>();
  for (const r of p.requests ?? []) {
    const owner = r.repository.nameWithOwner.split("/")[0];
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  const orgs = p.orgs?.orgs ?? [];
  // Organizations seen in requests but missing from `user/orgs` (private membership) still get a row.
  const fromRequests = [...counts.keys()].filter((o) => !orgs.includes(o) && o !== p.orgs?.login);
  const personalCount = [...counts.entries()].filter(([o]) => o === p.orgs?.login || (!orgs.includes(o) && p.orgs)).reduce((n, [, c]) => n + c, 0);
  const all = [...orgs].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const shown = (o: string) => (s.orgMode === "all" ? !s.hiddenOrgs.includes(o) : s.selectedOrgs.includes(o));
  const toggle = (o: string, on: boolean) =>
    s.orgMode === "all"
      ? p.update({ hiddenOrgs: on ? s.hiddenOrgs.filter((x) => x !== o) : [...s.hiddenOrgs, o] })
      : p.update({ selectedOrgs: on ? [...s.selectedOrgs, o] : s.selectedOrgs.filter((x) => x !== o) });

  return (
    <>
      <h1>Organizations</h1>
      <p className="lead">Choose whose pull requests appear in your inbox. Hidden ones are left out of the list, counts and refreshes. Nothing changes on GitHub.</p>
      <div className="set-group">
        <Row label="Show" hint={s.orgMode === "all" ? "Organizations you join later appear automatically." : "Organizations you join later stay hidden until you check them."}>
          <Seg label="Show" value={s.orgMode} options={[["all", "All except unchecked"], ["selected", "Only checked"]]} onChange={(v) => p.update({ orgMode: v })} />
        </Row>
        <Check label="Personal repositories" hint="Repositories owned by you or other people, not an organization" checked={s.includePersonal} onChange={(v) => p.update({ includePersonal: v })} />
      </div>

      <div className="set-group">
        <div className="set-title" style={{ display: "flex", alignItems: "center" }}>
          <span style={{ flex: 1 }}>Your organizations{p.orgs ? ` · signed in as ${p.orgs.login}` : ""}</span>
          <button type="button" className="tb" style={{ width: 22, height: 22 }} aria-label="Reload organizations" title="Reload organizations" onClick={p.onReloadOrgs}><RefreshCw size={13} /></button>
        </div>
        {p.orgsError && <div className="set-row status-bad" style={{ fontSize: 12 }}>{p.orgsError}</div>}
        {!p.orgs && !p.orgsError && <div className="set-row muted">Loading organizations…</div>}
        {p.orgs && all.length === 0 && <div className="set-row muted">gh didn't return any organizations. If you expected some, your token may need the read:org scope (gh auth refresh -s read:org).</div>}
        {all.map((o) => (
          <label key={o} className={shown(o) ? "org-row" : "org-row off"}>
            <input type="checkbox" checked={shown(o)} onChange={(e) => toggle(o, e.target.checked)} />
            <span className="org-av">{o[0].toUpperCase()}</span>
            <span className="org-name" style={{ flex: 1 }}>{o}</span>
            <span className="muted" style={{ fontSize: 12 }}>{counts.get(o) ? `${counts.get(o)} waiting` : ""}</span>
          </label>
        ))}
        {fromRequests.length > 0 && p.orgs && (
          <div className="set-row muted" style={{ fontSize: 12 }}>Also requesting reviews, counted as personal: {fromRequests.join(", ")}{personalCount ? ` (${personalCount})` : ""}</div>
        )}
      </div>

      <div className="set-group">
        <div className="set-title">Review requests</div>
        <Check label="Include team requests" hint="Reviews requested from a team you're on, not only from you" checked={s.includeTeams} onChange={(v) => p.update({ includeTeams: v })} />
        <Check label="Show draft pull requests" checked={s.showDrafts} onChange={(v) => p.update({ showDrafts: v })} />
      </div>
    </>
  );
}

function Tools(p: Props) {
  const s = p.settings;
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.toolStatus>> | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const check = () => {
    setChecking(true);
    api.toolStatus().then(setStatus).catch((e) => setStatus({ ghError: errorText(e), dataDir: "" })).finally(() => setChecking(false));
  };
  const agent = harnessOf(s);
  useEffect(check, [s.ghPath, s.claudePath, s.codexPath, s.geminiPath, s.copilotPath, s.harness, s.dataDir]);

  const Status = ({ ok, text, error }: { ok?: string; text?: string; error?: string }) =>
    ok ? <span className="status-ok" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}><CircleCheck size={13} />{text ?? ok}</span>
       : <span className="status-bad" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}><CircleX size={13} />{error ?? "Not found"}</span>;

  return (
    <>
      <h1>Tools & storage</h1>
      <p className="lead">BetterLGTM runs the GitHub CLI and {agent.name} installed on this computer. Set full paths if the app can't find them, for example when it's started from a launcher instead of a terminal.</p>
      <div className="set-group">
        <div className="set-title" style={{ display: "flex", alignItems: "center" }}>
          <span style={{ flex: 1 }}>Commands</span>
          <button type="button" className="tb" style={{ width: 22, height: 22 }} aria-label="Check again" title="Check again" onClick={check}><RefreshCw size={13} className={checking ? "spin" : undefined} /></button>
        </div>
        <Row label="GitHub CLI" hint={status && <Status ok={status.gh} text={status.gh && `${status.gh}${status.login ? ` · signed in as ${status.login}` : ""}`} error={status.ghError} />}>
          <TextSetting mono value={s.ghPath} placeholder="gh" onSave={(v) => p.update({ ghPath: v || DEFAULT_SETTINGS.ghPath })} />
        </Row>
        <Row label={agent.name} hint={status && status.harness === agent.id && <Status ok={status.agent} error={status.agentError} />}>
          <TextSetting mono value={s[agent.pathKey]} placeholder={agent.command} onSave={(v) => p.update({ [agent.pathKey]: v || DEFAULT_SETTINGS[agent.pathKey] })} />
        </Row>
      </div>
      <div className="set-group">
        <div className="set-title">Storage</div>
        <Row label="Data folder" hint={<>Clones and worktrees live here.{status?.dataDir ? <> Now: <code>{status.dataDir}</code></> : null}</>}>
          <TextSetting mono value={s.dataDir} placeholder="~/.betterlgtm" onSave={(v) => p.update({ dataDir: v })} />
        </Row>
        <Row label="Saved reviews" hint="Analyses, guided reviews, chat history and review progress stored by the app. Clones and worktrees stay on disk.">
          {confirmClear ? (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button type="button" className="btn sm danger" onClick={() => { p.onClearData(); setConfirmClear(false); }}>Delete all</button>
              <button type="button" className="btn sm" onClick={() => setConfirmClear(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="btn sm danger" onClick={() => setConfirmClear(true)}>Clear…</button>
          )}
        </Row>
      </div>
    </>
  );
}

export function Settings(p: Props) {
  const s = p.settings;
  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 4px 0 10px", marginBottom: 4 }}>
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }} className="muted">Settings</span>
          {p.onClose && <button type="button" className="tb" aria-label="Close settings (Esc)" title="Close (Esc)" onClick={p.onClose}><X size={15} /></button>}
        </div>
        {SECTIONS.map((x) => (
          <button key={x.id} type="button" className={p.section === x.id ? "row sel" : "row"} aria-current={p.section === x.id ? "page" : undefined} onClick={() => p.onSection(x.id)}>
            <x.icon size={14} className="tone-muted" />{x.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {p.section === "general" && (
          <>
            <h1>General</h1>
            <p className="lead">How the app looks, how often it checks GitHub, and how it updates.</p>
            <div className="set-group">
              <Row label="Theme">
                <Seg label="Theme" value={s.theme} options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]} onChange={(v) => p.update({ theme: v })} />
              </Row>
              <Row label="Zoom" hint={`Text and layout size. ${zoomKeys} change it from anywhere`}>
                <select className="set-input" value={s.zoom} onChange={(e) => p.update({ zoom: Number(e.target.value) })}>
                  {(ZOOM_STEPS.includes(s.zoom) ? ZOOM_STEPS : [...ZOOM_STEPS, s.zoom].sort((a, b) => a - b)).map((z) => <option key={z} value={z}>{Math.round(z * 100)}%{z === 1 ? " (default)" : ""}</option>)}
                </select>
              </Row>
              <Row label="Check for review requests" hint="Also when you press refresh in the inbox">
                <select className="set-input" value={s.refreshMinutes} onChange={(e) => p.update({ refreshMinutes: Number(e.target.value) })}>
                  {[1, 2, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>Every {m} {m === 1 ? "minute" : "minutes"}</option>)}
                </select>
              </Row>
              <Check label="Notify me about review requests" hint="A desktop notification when a review is requested or requested again, and a count on the app icon. Hidden organizations are left out." checked={s.notifications} onChange={(v) => p.update({ notifications: v })} />
              <Check label="Vim-style keys" hint="j/k to move, h/l to switch panes, gg/G, n/N for findings and more. Press ? for the full list." checked={s.vimKeys} onChange={(v) => p.update({ vimKeys: v })} />
              <Check label="Share anonymous usage stats" hint="Counts of app opens, reviews and actions, with the app version and system. Never code, findings, chat, or repository, PR or account names." checked={s.usageStats} onChange={(v) => p.update({ usageStats: v })} />
              <Check label="Check for app updates automatically" hint="New versions download only when you choose Install" checked={s.autoUpdate} onChange={(v) => p.update({ autoUpdate: v })} />
            </div>
          </>
        )}
        {p.section === "orgs" && <Organizations {...p} />}
        {p.section === "review" && (
          <>
            <h1>Review</h1>
            <p className="lead">Defaults for the Diff tab. You can still switch while reviewing; the last choice is remembered.</p>
            <div className="set-group">
              <Row label="Diff view" hint="Guided groups related changes into sections">
                <Seg label="Diff view" value={s.diffMode} options={[["guided", "Guided"], ["files", "Files"]]} onChange={(v) => p.update({ diffMode: v })} />
              </Row>
              <Row label="Diff layout" hint="Split needs a wide window">
                <Seg label="Diff layout" value={s.diffLayout} options={[["unified", "Unified"], ["split", "Split"]]} onChange={(v) => p.update({ diffLayout: v })} />
              </Row>
              <Check label="Hide generated files" hint="Guided review leaves out lockfiles, build output, snapshots and generated code; the Files view folds them" checked={s.hideGenerated} onChange={(v) => p.update({ hideGenerated: v })} />
              <div className="set-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <div className="set-label">
                  <span>More generated files</span>
                  <span>One glob per line. <code>*</code> stays in a folder, <code>**</code> spans folders, a trailing <code>/</code> covers a whole folder. The agent skips these too.</span>
                </div>
                <GeneratedPatterns value={s.generatedPatterns} onSave={(v) => p.update({ generatedPatterns: v })} />
              </div>
              <Check label="Hide test files" hint="Guided review leaves out tests and specs; the Files view folds them. The agent still reads them to check coverage" checked={s.hideTests} onChange={(v) => p.update({ hideTests: v })} />
            </div>
          </>
        )}
        {p.section === "claude" && (
          <>
            <h1>Agent</h1>
            <p className="lead">The coding agent that runs analyses and chat, and how it runs. It only gets to read.</p>
            <div className="set-group">
              <Row label="Coding agent" hint={harnessOf(s).limits ?? "Runs with read-only tools, and can stop automatic analyses at a spending limit"}>
                <select className="set-input" aria-label="Coding agent" value={harnessOf(s).id} onChange={(e) => p.update({ harness: e.target.value as HarnessId, model: "" })}>
                  {HARNESS_IDS.map((id) => <option key={id} value={id}>{HARNESSES[id].name}</option>)}
                </select>
              </Row>
              {harnessOf(s).models.length > 0 ? (
                <>
                  <Row label="Model" hint={`Leave on default to use ${harnessOf(s).name}'s own setting`}>
                    <select className="set-input" value={["", ...harnessOf(s).models.map(([v]) => v)].includes(s.model) ? s.model : "custom"} onChange={(e) => p.update({ model: e.target.value === "custom" ? s.model || "claude-" : e.target.value })}>
                      <option value="">Default</option>
                      {harnessOf(s).models.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      <option value="custom">Other…</option>
                    </select>
                  </Row>
                  {!["", ...harnessOf(s).models.map(([v]) => v)].includes(s.model) && (
                    <Row label="Model name" hint="A full model ID, for example claude-opus-5-5">
                      <TextSetting mono value={s.model} onSave={(v) => p.update({ model: v })} />
                    </Row>
                  )}
                </>
              ) : (
                <Row label="Model" hint={`A model name ${harnessOf(s).name} accepts. Leave empty to use its own setting`}>
                  <TextSetting mono value={s.model} placeholder="Default" onSave={(v) => p.update({ model: v })} />
                </Row>
              )}
              {harnessOf(s).effort && (
              <Row label="Effort" hint="Higher effort is more thorough, slower and uses more tokens">
                <select className="set-input" value={s.effort} onChange={(e) => p.update({ effort: e.target.value })}>
                  <option value="">Default</option>
                  {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}
                </select>
              </Row>
              )}
              <Check
                label="Double-check findings"
                hint="A second pass tries to disprove each critical, high and medium finding, and drops the ones the code doesn't support. It also checks each description claim's verdict and corrects the ones the code contradicts. Analyses take longer and use more tokens."
                checked={s.verifyFindings}
                onChange={(v) => p.update({ verifyFindings: v })}
              />
              {s.verifyFindings && <VerifyWith {...p} />}
            </div>
            <div className="set-group">
              <div className="set-title">Auto-analyze</div>
              <Check
                label="Analyze new review requests automatically"
                hint={`Runs in the background for requests that arrive after you turn this on, so results are ready when you open the PR. Uses ${harnessOf(s).short} tokens for every request.`}
                checked={s.autoAnalyze}
                onChange={(v) => p.update({ autoAnalyze: v, ...(v ? { autoAnalyzeSince: Date.now() } : {}) })}
              />
              {s.autoAnalyze && (
                <>
                  <Check label="Include draft pull requests" checked={s.autoAnalyzeDrafts} onChange={(v) => p.update({ autoAnalyzeDrafts: v })} />
                  <Row label="Run at once" hint={`More at once finishes sooner but uses more of your ${harnessOf(s).short} limits`}>
                    <select className="set-input" value={s.autoAnalyzeLimit} onChange={(e) => p.update({ autoAnalyzeLimit: Number(e.target.value) })}>
                      {[1, 2, 3].map((n) => <option key={n} value={n}>{n === 1 ? "1 analysis" : `${n} analyses`}</option>)}
                    </select>
                  </Row>
                  <Row label="Spending limit" hint="An automatic analysis stops when it has cost this much, as Claude Code counts it">
                    <select className="set-input" value={s.autoAnalyzeBudgetUsd} onChange={(e) => p.update({ autoAnalyzeBudgetUsd: Number(e.target.value) })}>
                      {[1, 2, 5, 10, 20].map((n) => <option key={n} value={n}>${n} per analysis</option>)}
                      <option value={0}>No limit</option>
                    </select>
                  </Row>
                </>
              )}
            </div>
            <div className="set-group">
              <div className="set-title" style={{ display: "flex", alignItems: "center", gap: 6 }}><Cpu size={13} />Extra review instructions</div>
              <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>Added to every analysis. For example: what your team cares about, or what to ignore.</span>
                <ReviewInstructions value={s.reviewInstructions} onSave={(v) => p.update({ reviewInstructions: v })} />
                <span className="muted" style={{ fontSize: 12 }}>{harnessOf(s).short} also follows a repository's own REVIEW.md or review section in CONTRIBUTING.md.</span>
              </div>
            </div>
            <RepoInstructions {...p} />
          </>
        )}
        {p.section === "tools" && <Tools {...p} />}
      </div>
    </div>
  );
}

/** Instructions that only apply to one repository's analyses. */
function RepoInstructions(p: Props) {
  const s = p.settings;
  const known = [...new Set([...(p.requests ?? []).map((r) => r.repository.nameWithOwner), ...Object.keys(s.repoInstructions)])].sort();
  const [repo, setRepo] = useState(known[0] ?? "");
  const save = (v: string) => {
    const all = { ...s.repoInstructions };
    if (v.trim()) all[repo] = v;
    else delete all[repo];
    p.update({ repoInstructions: all });
  };
  return (
    <div className="set-group">
      <div className="set-title" style={{ display: "flex", alignItems: "center", gap: 6 }}><Cpu size={13} />Instructions for one repository</div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Added after the instructions above, only for this repository.</span>
        <input
          className="set-input"
          list="repo-instruction-repos"
          placeholder="owner/repository"
          aria-label="Repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value.trim())}
        />
        <datalist id="repo-instruction-repos">{known.map((r) => <option key={r} value={r} />)}</datalist>
        {repo.includes("/") && <ReviewInstructions value={s.repoInstructions[repo] ?? ""} onSave={save} />}
        {Object.keys(s.repoInstructions).length > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>Repositories with instructions: {Object.keys(s.repoInstructions).sort().join(", ")}</span>
        )}
      </div>
    </div>
  );
}

/** Saves the globs when you leave the field, so a half-typed glob doesn't hide files. */
function GeneratedPatterns({ value, onSave }: { value: string[]; onSave: (v: string[]) => void }) {
  const text = value.join("\n");
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <textarea
      className="set-input"
      style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}
      aria-label="More generated files"
      spellCheck={false}
      value={draft}
      placeholder={"**/*.gen.ts\napi/openapi/\nschema.graphql"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.split("\n").map((l) => l.trim()).filter(Boolean);
        if (next.join("\n") !== text) onSave(next);
      }}
    />
  );
}

function ReviewInstructions({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="set-input"
      value={draft}
      placeholder={"- Flag any change to the public API\n- Ignore formatting in generated SQL"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
    />
  );
}
