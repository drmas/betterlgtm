import type { LinkedIssue, PrDetails, ReviewThread } from "./api";
import type { HarnessId } from "./harness";

export type Verdict = "implemented" | "partial" | "contradicted" | "missing";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Anchor {
  path: string;
  startLine: number;
  endLine: number;
}

export interface Claim {
  text: string;
  verdict: Verdict;
  note?: string;
  anchors: Anchor[];
  /** Index into `findings` when the problem is explained by a finding. */
  finding?: number;
  /** Where the claim comes from when it isn't the description, such as "#311". */
  source?: string;
  /** The second pass's look at the verdict. `previous` is set when it changed the verdict. */
  check?: { status: "confirmed" | "changed" | "uncertain"; previous?: Verdict; note: string; by?: HarnessId };
}

/** A change the description doesn't mention. Not necessarily a problem. */
export interface Unmentioned {
  text: string;
  anchors: Anchor[];
}

/** A finding the reviewer dismissed on another PR in the same repository, used to quiet the same point here. */
export interface RepoDismissal {
  title: string;
  /** The file it was about, when known. */
  path?: string;
  reason?: string;
  /** The PR it was dismissed on, such as "#481". */
  pr?: string;
}

export interface Finding {
  severity: Severity;
  category: string;
  title: string;
  body: string;
  fix?: string;
  /** Exact replacement for the lines of the first anchor, when the fix is small and certain. */
  suggestion?: string;
  confidence?: "high" | "medium" | "low";
  notInDescription?: boolean;
  anchors: Anchor[];
  /** Set when the finding repeats one from an earlier analysis, so the reviewer's state stays with it. */
  id?: string;
  /** Position of the earlier finding this one repeats, as Claude reported it. Turned into `id`. */
  previous?: number;
  /** The result of the second pass that tried to disprove the finding. */
  /** The second pass. "disputed": an agent other than the one that reported it refuted it; `by` names that agent. */
  check?: { status: "confirmed" | "uncertain" | "disputed"; note: string; by?: HarnessId };
}

/** One step of the guided review: related changes across files, read together. */
export interface WalkStep {
  title: string;
  /** Markdown bullets: what changed and why. */
  why: string;
  changes: Anchor[];
}

export type Decision = "approve" | "comment" | "request_changes";

export interface Analysis {
  /** Two or three plain sentences on what the PR does. Missing in analyses from older versions. */
  summary?: string;
  recommendation?: { decision: Decision; reason: string };
  claims: Claim[];
  findings: Finding[];
  /** Guided review steps. Missing in analyses from older versions; can be generated separately. */
  walkthrough?: WalkStep[];
  /** Repository guideline files Claude followed, such as REVIEW.md. */
  guidelines?: string[];
  /** Sensitive areas the PR touches. */
  risks?: Risk[];
  /** Whether the main changes are covered by tests. */
  tests?: TestCheck[];
  /** Findings the second pass disproved, with the reason. Not shown as findings. */
  dropped?: { finding: Finding; note: string }[];
  /** The double-check by another agent couldn't run or gave no readable answer; the findings are unchecked. */
  verifyFailed?: { by: HarnessId; error: string };
  /** Changes the description doesn't mention. Missing in analyses from older versions. */
  unmentioned?: Unmentioned[];
  /** Dismissals from other PRs in the repository that the analysis was told about. */
  repoDismissals?: RepoDismissal[];
}

export interface Risk {
  area: string;
  why: string;
  anchors: Anchor[];
}

export interface TestCheck {
  change: string;
  covered: "yes" | "partly" | "no";
  tests: string[];
  note?: string;
}

const WALKTHROUGH_RULES = `Group the changes into review steps for a guided review:
- Each step collects related changes across files that should be read together
  (for example: a new type, the function that fills it, and the UI that shows it).
- Order the steps so each one builds on the previous: foundations first, then usage, then tests.
- 3–10 steps. Every changed hunk belongs to exactly one step, except in generated files
  (lockfiles, build output, snapshots, generated code): leave those out, the reviewer doesn't read them.
  Put trivial changes (renames, formatting, docs) together in one late step.
- Title up to 8 words. "why" is 1–3 short bullets: what changed and why it matters.
- "changes" lists line ranges in the new version of each file. For deleted files use startLine 0 and endLine 0.`;

const WALKTHROUGH_SHAPE = `"walkthrough": [{ "title": "...", "why": ["..."], "changes": [{ "path": "src/x.ts", "startLine": 10, "endLine": 40 }] }]`;

// Schemas for `claude --json-schema`. They fix the structure; the prompts explain what goes in each field.
const TEXT = { type: "string" };
const LINES = { type: "array", items: TEXT };
const ANCHORS = {
  type: "array",
  items: { type: "object", properties: { path: TEXT, startLine: { type: "integer" }, endLine: { type: "integer" } }, required: ["path", "startLine", "endLine"] },
};
const RECOMMENDATION = {
  type: "object",
  properties: { decision: { enum: ["approve", "comment", "request_changes"] }, reason: TEXT },
  required: ["decision", "reason"],
};

export const WALKTHROUGH_SCHEMA = {
  type: "object",
  properties: {
    walkthrough: { type: "array", items: { type: "object", properties: { title: TEXT, why: LINES, changes: ANCHORS }, required: ["title", "why", "changes"] } },
  },
  required: ["walkthrough"],
};

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: LINES,
    guidelines: LINES,
    risks: { type: "array", items: { type: "object", properties: { area: TEXT, why: TEXT, anchors: ANCHORS }, required: ["area", "why"] } },
    tests: {
      type: "array",
      items: { type: "object", properties: { change: TEXT, covered: { enum: ["yes", "partly", "no"] }, tests: LINES, note: TEXT }, required: ["change", "covered"] },
    },
    recommendation: RECOMMENDATION,
    unmentioned: { type: "array", items: { type: "object", properties: { text: TEXT, anchors: ANCHORS }, required: ["text", "anchors"] } },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { text: TEXT, verdict: { enum: ["implemented", "partial", "contradicted", "missing"] }, note: TEXT, finding: { type: "integer" }, source: TEXT, anchors: ANCHORS },
        required: ["text", "verdict", "anchors"],
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          category: TEXT,
          title: TEXT,
          body: LINES,
          fix: TEXT,
          suggestion: TEXT,
          confidence: { enum: ["high", "medium", "low"] },
          notInDescription: { type: "boolean" },
          previous: { type: "integer" },
          anchors: ANCHORS,
        },
        required: ["severity", "category", "title", "body", "anchors"],
      },
    },
  },
  required: ["summary", "recommendation", "claims", "findings"],
};

export const RECHECK_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: { type: "object", properties: { index: { type: "integer" }, status: { enum: ["fixed", "open", "changed", "unclear"] }, note: TEXT }, required: ["index", "status", "note"] },
    },
  },
  required: ["results"],
};

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: { type: "object", properties: { index: { type: "integer" }, status: { enum: ["confirmed", "refuted", "uncertain"] }, note: TEXT }, required: ["index", "status", "note"] },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, verdict: { enum: ["implemented", "partial", "contradicted", "missing", "uncertain"] }, note: TEXT },
        required: ["index", "verdict", "note"],
      },
    },
    recommendation: RECOMMENDATION,
  },
  required: ["results"],
};

/**
 * VERIFY_SCHEMA in the strict form Codex's --output-schema needs: every object lists all its properties
 * as required and allows no others, so the optional ones may be null instead of absent.
 */
export const VERIFY_SCHEMA_STRICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: { index: { type: "integer" }, status: { enum: ["confirmed", "refuted", "uncertain"] }, note: TEXT }, required: ["index", "status", "note"] },
    },
    claims: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: { index: { type: "integer" }, verdict: { enum: ["implemented", "partial", "contradicted", "missing", "uncertain"] }, note: TEXT },
        required: ["index", "verdict", "note"],
      },
    },
    recommendation: { ...RECOMMENDATION, type: ["object", "null"], additionalProperties: false },
  },
  required: ["results", "claims", "recommendation"],
};

/** Asks the analysis session to group the PR's changes into guided review steps. */
export function buildWalkthroughPrompt(generatedPatterns: string[] = []): string {
  return `${WALKTHROUGH_RULES}${generatedNote(generatedPatterns)}

Use the PR you analyzed earlier in this session (git diff against the base branch).
Give the result as one JSON object: { ${WALKTHROUGH_SHAPE} }`;
}

/** A finding from the PR's previous analysis, with what the reviewer did with it. */
export interface EarlierFinding {
  finding: Finding;
  state?: FindingState;
}

/** The reviewer's own generated-file globs, for the agent to skip like the built-in ones. */
function generatedNote(patterns: string[]): string {
  const globs = patterns.map((g) => g.trim()).filter((g) => g && !g.startsWith("#"));
  return globs.length ? `\nAlso treat files matching these globs as generated: ${globs.map((g) => `\`${g}\``).join(", ")}.` : "";
}

export interface AnalysisOptions {
  /** The reviewer's own instructions, global and for this repository. */
  instructions?: string;
  /** The reviewer's own generated-file globs. */
  generatedPatterns?: string[];
  /** A re-review: focus on what changed after this commit. */
  since?: string;
  issues?: LinkedIssue[];
  threads?: ReviewThread[];
  /** The reviewer wrote this PR. */
  selfReview?: boolean;
  /** Findings of the previous analysis of this PR. */
  earlier?: EarlierFinding[];
  /** Findings the reviewer dismissed on other PRs in this repository. */
  dismissedInRepo?: RepoDismissal[];
}

const STATE_NOTE: Record<FindingStateKind, string> = {
  dismissed: "dismissed by the reviewer",
  resolved: "marked resolved by the reviewer",
  commented: "already posted as a review comment",
};

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildAnalysisPrompt(pr: PrDetails, o: AnalysisOptions = {}): string {
  const { since, issues = [], threads = [], earlier = [], dismissedInRepo = [] } = o;
  const extra = o.instructions?.trim() ? `\n\nThe reviewer's own instructions (follow them):\n${o.instructions.trim()}` : "";
  const focus = since
    ? `\n\nThis is a re-review. The reviewer last reviewed commit ${since}. Focus on what changed since then: git diff ${since} HEAD (and git log ${since}..HEAD). Use the full PR diff only for context. Report findings only for code changed since ${since}, and check description claims only where the new commits affect them. Mention in the summary that this covers the changes since the last review.`
    : "";
  const linked = issues.length
    ? `\n\nThe PR says it closes these issues. Turn their concrete requirements into claims as well, check them the same way, and set "source" to the issue number (for example "#${issues[0].number}"):\n` +
      issues.map((i) => `<issue number="${i.number}" title="${i.title.replace(/"/g, "'")}">\n${(i.body ?? "").trim().slice(0, 2000) || "(no description)"}\n</issue>`).join("\n")
    : "";
  const open = threads.filter((t) => !t.isResolved && t.comments.length);
  const discussed = open.length
    ? `\n\nReviewers have already raised these points on the PR. Don't report them again as findings; only add what they missed:\n` +
      open.map((t) => `- ${t.path}${t.line ? `:${t.line}` : ""} (${t.comments[0].author}): ${t.comments[0].body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")
    : "";
  const before = earlier.length
    ? `\n\nAn earlier analysis of this PR reported these findings:\n` +
      earlier
        .map(({ finding: f, state }, i) => {
          const note = state ? ` [${STATE_NOTE[state.state]}${state.reason ? `: ${oneLine(state.reason, 120)}` : ""}]` : "";
          return `[${i}] (${f.severity}) ${f.title} — ${f.anchors.map(anchorLabel).join(", ") || "no location"}${note}`;
        })
        .join("\n") +
      `\nCheck the code again rather than trusting this list. When a finding of yours is the same problem as one of these, keep its title and set "previous" to its number. Leave out the ones that are fixed. Don't report a dismissed one again unless the code changed in a way that makes it matter.`
    : "";
  const habits = dismissedInRepo.length
    ? `\n\nOn other pull requests in this repository, the reviewer dismissed these findings:\n` +
      dismissedInRepo.map((d) => `- ${oneLine(d.title, 100)}${d.path ? ` (in ${d.path})` : ""}${d.reason ? `: ${oneLine(d.reason, 120)}` : ""}`).join("\n") +
      `\nDon't report the same point in the same file again unless it is clearly more serious here. This covers only that point: report other problems of the same kind, and the same point in other files, as usual.`
    : "";
  const self = o.selfReview
    ? `\n\nThis is the reviewer's own pull request: they wrote it and want to check it before asking others to review. Address them as the author ("you"). In "recommendation", approve means it's ready to ask for reviews, comment means it's worth another look first, and request_changes means fix these before asking anyone.`
    : "";
  return baseAnalysisPrompt(pr, o.generatedPatterns) + linked + discussed + before + habits + self + focus + extra;
}

function baseAnalysisPrompt(pr: PrDetails, generatedPatterns: string[] = []): string {
  return `You are helping a developer review pull request #${pr.number} "${pr.title}" by ${pr.author.login}.
The PR head is checked out in the current directory (detached HEAD). The base branch is origin/${pr.baseRefName}.
See the change with: git diff origin/${pr.baseRefName}...HEAD

PR description (written by the author):
<description>
${pr.body?.trim() || "(empty)"}
</description>

Do this, using only read-only commands:
0. Look for review guidelines in the repository: REVIEW.md, .github/REVIEW.md, docs/REVIEW.md, CODE_REVIEW.md, and any
   review section in CONTRIBUTING.md. If there are any, follow them, and list the files you used in "guidelines".
1. Split the description into concrete claims. For each, check the code and give a verdict:
   implemented, partial, contradicted (the code does the opposite or breaks the claim), or missing (not in the PR).
1a. In "unmentioned", list what the PR changes that the description doesn't mention: a refactor, a changed default,
   leftover debug code, a new dependency, a file outside the stated scope. One line each, with its location. Being on
   this list doesn't make a change a problem. Leave out formatting, renames within the changed lines, generated files
   and anything a claim already covers. If the description is empty, leave the list empty.
2. Find the most important things a reviewer should look at: bugs, security problems, behavior changes,
   missing tests, risky data handling. When a finding is about a change the description doesn't mention, set
   notInDescription (and list the change in "unmentioned" too).
   Rank them by severity: critical, high, medium, low. Skip style nits.
3. Summarize what the PR does and recommend a decision: approve, comment, or request_changes.
3a. In "risks", list the sensitive areas the PR touches: authentication or permissions, database migrations or schema,
   CI or deployment config, dependencies, public APIs, money or personal data. One line on why it matters here.
3b. In "tests", for each significant behavior change, say whether changed or existing tests exercise it
   (yes, partly, no) and name the test files. Read the tests; don't run anything.

Don't read generated files (lockfiles, build output, snapshots, generated code) line by line;
only mention them if their change is unexpected, for example a lockfile change with no dependency change.${generatedNote(generatedPatterns)}

The reviewer skims. Be brief and concrete:
- Use bullet points, not paragraphs. Every bullet is one short line, at most about 12 words.
- No filler, no hedging, no repeating the title. Say what breaks and why it matters.
- Use \`inline code\` for identifiers. No headings, no bold.
- Limits: title up to 8 words; summary 2–4 bullets; finding body 1–3 bullets; fix one line;
  claim note one line; recommendation reason one line; risk "why" one line; "unmentioned" text one line.
When a finding's fix is a small, certain change to exactly the lines of its first anchor, add "suggestion":
the full replacement text for those lines (startLine to endLine of the new file), with the original indentation and
no diff markers. Leave it out when the fix touches other lines or you aren't sure.
Line numbers refer to the new version of the file. Paths are relative to the repository root.
When you are done, give the result as one JSON object in this shape:

\`\`\`json
{
  "summary": ["...", "..."],
  "guidelines": ["REVIEW.md"],
  "risks": [{ "area": "Database migration", "why": "...", "anchors": [{ "path": "db/migrate/x.rb", "startLine": 1, "endLine": 20 }] }],
  "tests": [{ "change": "...", "covered": "yes|partly|no", "tests": ["spec/x_spec.rb"], "note": "..." }],
  "recommendation": { "decision": "approve|comment|request_changes", "reason": "..." },
  "unmentioned": [{ "text": "...", "anchors": [{ "path": "src/x.ts", "startLine": 10, "endLine": 14 }] }],
  "claims": [{ "text": "...", "verdict": "implemented|partial|contradicted|missing", "note": "...", "finding": 0, "source": "#12 (only for claims from an issue)",
               "anchors": [{ "path": "src/x.ts", "startLine": 10, "endLine": 14 }] }],
  "findings": [{ "severity": "critical|high|medium|low", "category": "Correctness|Security|Behavior change|Tests|Data handling|Performance|Maintainability",
                 "title": "...", "body": ["...", "..."], "fix": "...", "suggestion": "replacement lines", "confidence": "high|medium|low", "notInDescription": false,
                 "anchors": [{ "path": "src/x.ts", "startLine": 10, "endLine": 14 }] }]
}
\`\`\`
"text" on a claim is the claim as the description states it, shortened to one line.
"finding" on a claim is the index of the finding that explains the problem, or omit it.`;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Bullet lists come back as arrays; older analyses used prose strings. Both become Markdown. */
function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((item) => `- ${String(item).replace(/^[-*•]\s*/, "")}`).join("\n");
  return typeof v === "string" ? v : "";
}

/** Anchors with a path and line numbers; anything else would break the views that show them. */
function asAnchors(v: unknown): Anchor[] {
  return asArray<Anchor>(v)
    .filter((a) => a && typeof a.path === "string" && a.path.trim())
    .map((a) => {
      const start = Number.isFinite(Number(a.startLine)) ? Number(a.startLine) : 1;
      const end = Number.isFinite(Number(a.endLine)) ? Number(a.endLine) : start;
      return { path: a.path, startLine: start, endLine: Math.max(start, end) };
    });
}

/** Claude sometimes writes "High" or a level that doesn't exist; unknown levels count as low. */
function asSeverity(v: unknown): Severity {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s in SEVERITY_RANK ? (s as Severity) : "low";
}

function parseSteps(v: unknown): WalkStep[] | undefined {
  const steps = asArray<WalkStep>(v)
    .filter((s) => s && typeof s.title === "string")
    .map((s) => ({ title: s.title, why: asText(s.why), changes: asAnchors(s.changes) }));
  return steps.length ? steps : undefined;
}

/** What a run answered: the data when it was given a schema, otherwise its text. */
export const answerOf = (e: { structured_output?: unknown; result?: string | null }): unknown => e.structured_output ?? e.result ?? "";

/**
 * The objects an answer could be: the data itself when the run had a schema, otherwise the JSON blocks
 * in the text (last first) or the text as a whole. Older Claude Code versions only give text.
 */
function candidates(answer: unknown): Record<string, any>[] {
  if (answer && typeof answer === "object") return [answer as Record<string, any>];
  if (typeof answer !== "string") return [];
  const blocks = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const out: Record<string, any>[] = [];
  for (const raw of blocks.length ? blocks.reverse() : [answer]) {
    try {
      const data = JSON.parse(raw.trim());
      if (data && typeof data === "object") out.push(data);
    } catch {
      // not JSON: try the next block
    }
  }
  return out;
}

export function parseWalkthrough(answer: unknown): WalkStep[] | null {
  for (const data of candidates(answer)) {
    const steps = parseSteps(data.walkthrough);
    if (steps) return steps;
  }
  return null;
}

/** Reads the analysis out of Claude's final answer. Returns null when there is none. */
export function parseAnalysis(answer: unknown): Analysis | null {
  for (const data of candidates(answer)) {
    try {
      if (!Array.isArray(data.findings) && !Array.isArray(data.claims)) continue;
      const findings = asArray<Finding>(data.findings).filter((f) => f && typeof f === "object").map((f) => ({
        ...f,
        severity: asSeverity(f.severity),
        category: typeof f.category === "string" ? f.category : "",
        title: typeof f.title === "string" && f.title.trim() ? f.title : "Untitled finding",
        body: asText(f.body),
        fix: f.fix ? asText(f.fix) : undefined,
        suggestion: typeof f.suggestion === "string" && f.suggestion.trim() ? f.suggestion.replace(/\n$/, "") : undefined,
        anchors: asAnchors(f.anchors),
        previous: Number.isInteger(f.previous) ? f.previous : undefined,
        id: undefined,
        check: undefined,
      }));
      const order = findings.map((_, i) => i).sort((a, b) => SEVERITY_RANK[findings[a].severity] - SEVERITY_RANK[findings[b].severity]);
      const remap = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
      const rec = data.recommendation;
      return {
        summary: asText(data.summary) || undefined,
        guidelines: asArray<string>(data.guidelines).filter((g) => typeof g === "string" && g.trim()),
        risks: asArray<Risk>(data.risks)
          .filter((r) => r && typeof r.area === "string")
          .map((r) => ({ area: r.area, why: asText(r.why), anchors: asAnchors(r.anchors) })),
        tests: asArray<TestCheck>(data.tests)
          .filter((t) => t && typeof t.change === "string" && ["yes", "partly", "no"].includes(t.covered))
          .map((t) => ({ change: t.change, covered: t.covered, tests: asArray<string>(t.tests).filter((x) => typeof x === "string"), note: t.note ? asText(t.note) : undefined })),
        recommendation:
          rec && ["approve", "comment", "request_changes"].includes(rec.decision) ? { decision: rec.decision, reason: String(rec.reason ?? "") } : undefined,
        findings: order.map((i) => findings[i]),
        claims: asArray<Claim>(data.claims).map((c) => ({
          ...c,
          note: c.note ? asText(c.note) : undefined,
          source: typeof c.source === "string" && /^#?\d+/.test(c.source) ? `#${c.source.replace(/^#/, "").match(/^\d+/)![0]}` : undefined,
          anchors: asAnchors(c.anchors),
          finding: typeof c.finding === "number" ? remap.get(c.finding) : undefined,
        })),
        walkthrough: parseSteps(data.walkthrough),
        unmentioned: asArray<Unmentioned>(data.unmentioned)
          .filter((u) => u && typeof u.text === "string" && u.text.trim())
          .map((u) => ({ text: u.text, anchors: asAnchors(u.anchors) })),
      };
    } catch {
      // not the shape of an analysis: try the next one
    }
  }
  return null;
}

export function anchorLabel(a: Anchor): string {
  const file = a.path.split("/").pop() ?? a.path;
  return a.startLine === a.endLine ? `${file}:${a.startLine}` : `${file}:${a.startLine}–${a.endLine}`;
}

export type CheckStatus = "fixed" | "open" | "changed" | "unclear";

export interface FindingCheck {
  status: CheckStatus;
  note: string;
}

/** The result of re-checking a PR's findings after new commits. */
export interface FindingChecks {
  /** The commit the findings were made on, and the one they were re-checked at. */
  from: string;
  head: string;
  at: number;
  results: Record<number, FindingCheck>;
}

/** Asks Claude which of the earlier findings the new commits fixed. */
export function buildRecheckPrompt(findings: Finding[], from: string): string {
  const list = findings
    .map((f, i) => {
      const where = f.anchors.map(anchorLabel).join(", ") || "no location";
      return `[${i}] (${f.severity}) ${f.title} — ${where}\n${f.body}`;
    })
    .join("\n\n");
  return `The pull request has new commits since your analysis, which looked at commit ${from}. The current directory is now checked out at the latest head.
See what changed with: git diff ${from} HEAD

Re-check each finding below against the current code:

${list}

Statuses:
- fixed: the problem is gone.
- open: still present as described.
- changed: the code changed but the problem is only partly addressed, or it moved.
- unclear: you can't tell from the code.

Give the result as this JSON, one entry per finding, and a note of one short sentence saying why:
{"results": [{"index": 0, "status": "fixed", "note": "..."}]}`;
}

/** Results by finding index, keeping only entries with one of `statuses`. */
function parseResults<S extends string>(answer: unknown, statuses: readonly S[]): Record<number, { status: S; note: string }> | null {
  for (const data of candidates(answer)) {
    const results: Record<number, { status: S; note: string }> = {};
    for (const r of asArray<{ index: unknown; status: unknown; note: unknown }>(data.results)) {
      if (r && typeof r.index === "number" && statuses.includes(r.status as S)) {
        results[r.index] = { status: r.status as S, note: asText(r.note) };
      }
    }
    if (Object.keys(results).length) return results;
  }
  return null;
}

export function parseRecheck(answer: unknown): Record<number, FindingCheck> | null {
  return parseResults<CheckStatus>(answer, ["fixed", "open", "changed", "unclear"]);
}

export type VerifyStatus = "confirmed" | "refuted" | "uncertain";

/** Findings worth a second pass: the ones that would change the reviewer's decision. */
export const worthVerifying = (f: Finding) => f.severity !== "low";

const where = (anchors: Anchor[]) => anchors.map((x) => `${x.path}:${x.startLine}${x.endLine > x.startLine ? `-${x.endLine}` : ""}`).join(", ") || "no location";

/**
 * Asks a fresh session to try to disprove the findings and to check the claim verdicts. It hasn't seen
 * the analysis's reasoning, so it doesn't inherit its mistakes. `indexes` are positions in `a.findings`.
 */
export function buildVerifyPrompt(pr: PrDetails, a: Analysis, indexes: number[], checkClaims = true): string {
  const list = indexes
    .map((i) => {
      const f = a.findings[i];
      return `[${i}] (${f.severity}, ${f.category || "uncategorized"}) ${f.title} — ${where(f.anchors)}\n${f.body}${f.fix ? `\nSuggested fix: ${f.fix}` : ""}`;
    })
    .join("\n\n");
  const claims = checkClaims ? a.claims : [];
  const findingsPart = indexes.length
    ? `Another reviewer reported the findings below. Assume each one may be wrong and try to disprove it, using only read-only commands:
- Read the code at the location and around it. Check that the lines say what the finding claims.
- Follow callers and callees. Look for guards, validation, types, configuration or tests that already handle the case.
- Check whether the problem already existed before this PR and the PR doesn't touch it.

${list}

Statuses:
- confirmed: you read the code and the problem is real as described.
- refuted: the code shows the finding is wrong or already handled. Name the file:line that shows it.
- uncertain: you can't tell from the code either way.
Use refuted only when you can point to code that disproves the finding. A real problem you consider minor is still confirmed.`
    : "";
  const claimsPart = claims.length
    ? `The reviewer ${indexes.length ? "also " : ""}checked these claims from the PR description against the code. Check each verdict yourself:

${claims.map((c, i) => `[${i}] "${c.text}" — verdict: ${c.verdict}${c.note ? ` (${c.note.replace(/\s+/g, " ")})` : ""} — ${where(c.anchors)}`).join("\n")}

Verdicts: implemented, partial, contradicted (the code does the opposite or breaks the claim), missing (not in the PR).
In "claims", give the verdict you find for each one. Keep the reviewer's verdict unless you can point to code that shows a
different one, and then name that file:line in the note. Use "uncertain" when you can't tell from the code.`
    : "";
  const rec = a.recommendation ? `\n\nThe reviewer's recommendation was "${a.recommendation.decision}" (${a.recommendation.reason}). If the findings you refute or the verdicts you change alter it, give the new one in "recommendation" (approve, comment or request_changes, with a one-line reason). Otherwise leave "recommendation" out.` : "";
  return `You are double-checking a code review of pull request #${pr.number} "${pr.title}".
The PR head is checked out in the current directory (detached HEAD). The base branch is origin/${pr.baseRefName}.
See the change with: git diff origin/${pr.baseRefName}...HEAD

${[findingsPart, claimsPart].filter(Boolean).join("\n\n")}${rec}

Give the result as this JSON, one entry per finding and per claim, each with a note of one short sentence saying why:
{"results": [{"index": 0, "status": "confirmed", "note": "..."}], "claims": [{"index": 0, "verdict": "implemented", "note": "..."}]}`;
}

export type ClaimCheck = { verdict: Verdict | "uncertain"; note: string };

export function parseVerify(answer: unknown): {
  results: Record<number, { status: VerifyStatus; note: string }>;
  claims: Record<number, ClaimCheck>;
  recommendation?: Analysis["recommendation"];
} | null {
  const results = parseResults<VerifyStatus>(answer, ["confirmed", "refuted", "uncertain"]) ?? {};
  const claims: Record<number, ClaimCheck> = {};
  for (const data of candidates(answer)) {
    for (const r of asArray<{ index: unknown; verdict: unknown; note: unknown }>(data.claims)) {
      if (r && typeof r.index === "number" && ["implemented", "partial", "contradicted", "missing", "uncertain"].includes(r.verdict as string)) {
        claims[r.index] = { verdict: r.verdict as ClaimCheck["verdict"], note: asText(r.note) };
      }
    }
    if (Object.keys(claims).length) break;
  }
  if (!Object.keys(results).length && !Object.keys(claims).length) return null;
  const rec = candidates(answer).map((d) => d.recommendation).find((r) => r && ["approve", "comment", "request_changes"].includes(r.decision));
  return { results, claims, recommendation: rec ? { decision: rec.decision, reason: String(rec.reason ?? "") } : undefined };
}

/**
 * Applies the second pass: refuted findings move to `dropped`, the others keep the result as `check`.
 * A claim whose verdict the code shows to be wrong takes the new verdict, and keeps the old one in `check`.
 * With `by`, another agent did the checking: a finding it refutes is two agents disagreeing, so it stays,
 * marked disputed, for the reviewer to decide, and doesn't change the recommendation.
 */
export function applyVerification(a: Analysis, v: NonNullable<ReturnType<typeof parseVerify>>, by?: HarnessId): Analysis {
  const dropped = by ? [] : a.findings.flatMap((f, i) => (v.results[i]?.status === "refuted" ? [{ finding: f, note: v.results[i].note }] : []));
  const remap = new Map<number, number>();
  const findings: Finding[] = [];
  a.findings.forEach((f, i) => {
    const r = v.results[i];
    if (r?.status === "refuted" && !by) return;
    remap.set(i, findings.length);
    const status = r?.status === "refuted" ? "disputed" : (r?.status as "confirmed" | "uncertain");
    findings.push(r ? { ...f, check: { status, note: r.note, ...(by ? { by } : {}) } } : f);
  });
  let changed = 0;
  const claims = a.claims.map((c, i): Claim => {
    // A claim explained by a dropped finding keeps its verdict but loses the link.
    const base = { ...c, finding: typeof c.finding === "number" ? remap.get(c.finding) : undefined };
    const r = v.claims[i];
    if (!r) return base;
    const who = by ? { by } : {};
    if (r.verdict === "uncertain") return { ...base, check: { status: "uncertain", note: r.note, ...who } };
    if (r.verdict === c.verdict) return { ...base, check: { status: "confirmed", note: r.note, ...who } };
    changed++;
    return { ...base, verdict: r.verdict, check: { status: "changed", previous: c.verdict, note: r.note, ...who } };
  });
  return {
    ...a,
    findings,
    dropped: dropped.length ? dropped : undefined,
    claims,
    // The verifier's recommendation assumes the findings it refutes are gone. Disputed ones stay, so it can't be used then.
    recommendation: (dropped.length || changed) && v.recommendation && !findings.some((f) => f.check?.status === "disputed") ? v.recommendation : a.recommendation,
  };
}

/** Gives a finding that repeats an earlier one that finding's id, so the reviewer's state stays with it. */
export function carryFindingIds(a: Analysis, earlier: Finding[]): Analysis {
  const used = new Set<string>();
  return {
    ...a,
    findings: a.findings.map(({ previous, ...f }) => {
      const prev = typeof previous === "number" ? earlier[previous] : undefined;
      const id = prev ? findingId(prev) : undefined;
      if (!id || used.has(id)) return f;
      used.add(id);
      return { ...f, id };
    }),
  };
}

export type FindingStateKind = "dismissed" | "resolved" | "commented";

/** What the reviewer did with a finding. Kept per PR and matched to findings across re-runs. */
export interface FindingState {
  state: FindingStateKind;
  reason?: string;
  at: number;
}

/**
 * Whether a finding starts ticked in Submit review: what the reviewer added to the review, or else the
 * critical and high ones. A disputed finding isn't ticked by default, but adding it to the review counts as deciding.
 */
export function startsTicked(f: Finding, o: { fixed: boolean; hasState: boolean; inReview: number[]; index: number }): boolean {
  if (o.fixed || o.hasState) return false;
  if (o.inReview.length) return o.inReview.includes(o.index);
  return f.check?.status !== "disputed" && (f.severity === "critical" || f.severity === "high");
}

/** A finding another agent refuted, which the reviewer still has to decide on. */
export const isDisputed = (f: Finding) => f.check?.status === "disputed";

/** The findings line of the "Analysis ready" notification. Disputed findings are named, not counted as open. */
export function findingsSummary(findings: Finding[]): string {
  const disputed = findings.filter(isDisputed).length;
  const serious = findings.filter((f) => (f.severity === "critical" || f.severity === "high") && !isDisputed(f)).length;
  const main = serious
    ? `${serious} critical or high ${serious === 1 ? "finding" : "findings"}`
    : `${findings.length} ${findings.length === 1 ? "finding" : "findings"}, none critical or high`;
  return disputed ? `${main} (${disputed} disputed)` : main;
}

/** Outline order: by severity, and within one severity the disputed findings after the others. */
export function outlineOrder(x: { f: Finding }, y: { f: Finding }): number {
  return SEVERITY_RANK[x.f.severity] - SEVERITY_RANK[y.f.severity] || Number(isDisputed(x.f)) - Number(isDisputed(y.f));
}

/** Identifies a finding across analysis runs: the id carried over from an earlier run, or its first file and its title. */
export const findingId = (f: Finding) => f.id ?? `${f.anchors[0]?.path ?? ""}|${f.title.trim().toLowerCase()}`;

/**
 * A prompt to paste into the coding agent that wrote the PR, so it can fix the chosen findings on the author's branch.
 * Dismissed findings go in as "intended", so the agent doesn't undo them.
 */
export function buildHandoffPrompt(o: {
  pr: { number: number; headRefName: string };
  head?: string;
  analysis: Analysis;
  states?: Record<number, FindingState>;
  /** Indexes of the findings to fix. */
  findings: number[];
  /** Also list the description claims that don't match the code. */
  claims: boolean;
}): string {
  const { analysis: a, states = {} } = o;
  const where = (anchors: Anchor[]) =>
    anchors.map((x) => (x.startLine === x.endLine ? `${x.path}:${x.startLine}` : `${x.path}:${x.startLine}-${x.endLine}`)).join(", ") || "no location";
  const all = a.findings.map((f, i) => ({ f, i }));
  const picked = all.filter(({ i }) => o.findings.includes(i));
  const dismissed = all.filter(({ i }) => states[i]?.state === "dismissed" && !o.findings.includes(i));
  const claims = o.claims ? a.claims.filter((c) => c.verdict !== "implemented") : [];
  const VERDICT_TEXT: Record<Verdict, string> = { implemented: "implemented", partial: "partly implemented", contradicted: "contradicted by the code", missing: "missing" };

  const finding = ({ f, i }: { f: Finding; i: number }) =>
    [
      `### ${i + 1}. ${f.title} (${f.severity})`,
      `Where: ${where(f.anchors)}`,
      f.body,
      f.fix && `Fix: ${f.fix}`,
      f.suggestion && `Suggested replacement for the first location:\n\`\`\`\n${f.suggestion}\n\`\`\``,
      f.check && `Double-check: ${f.check.status}. ${f.check.note}`,
    ].filter(Boolean).join("\n");

  const head = o.head ? ` The review ran on commit ${o.head.slice(0, 7)}; if the branch has moved since, check each point against the current code.` : "";
  return [
    `Fix the review findings below on pull request #${o.pr.number}, branch \`${o.pr.headRefName}\`.${head}`,
    picked.length ? `## Findings\n\n${picked.map(finding).join("\n\n")}` : "",
    claims.length ? `## Description claims that don't match the code\n\n${claims.map((c) => `- "${c.text}": ${VERDICT_TEXT[c.verdict]}${c.note ? `. ${c.note}` : ""}`).join("\n")}` : "",
    dismissed.length
      ? `## Intended, don't change\n\nI dismissed these on purpose. Leave this behaviour as it is.\n\n${dismissed.map(({ f, i }) => `- ${f.title} (${where(f.anchors)})${states[i]?.reason ? `: ${states[i].reason}` : ""}`).join("\n")}`
      : "",
    `Check each finding against the code before changing anything; some may be wrong. When you're done, say which ones you didn't fix and why.`,
  ].filter(Boolean).join("\n\n");
}

/** Asks Claude to write the overall summary for the review the user is about to post. */
export function buildSummaryPrompt(event: string, comments: Finding[], notes: string): string {
  const decision = { APPROVE: "approve", REQUEST_CHANGES: "request changes", COMMENT: "comment without a decision" }[event] ?? "comment";
  const list = comments.length ? comments.map((f) => `- (${f.severity}) ${f.title}`).join("\n") : "(no line comments)";
  return `Write the overall summary for the GitHub review I'm about to post on this pull request.
My decision: ${decision}.
Line comments I'm posting:
${list}
${notes.trim() ? `\nWhat I've written so far (keep its intent):\n${notes.trim()}\n` : ""}
Write 2–4 short sentences addressed to the author: what the PR does well if it's worth saying, what must change and why, and what happens next. Be specific and plain; no greetings, no headings, no generic praise, no repeating each comment. Reply with only the summary text.`;
}

/** Asks Claude to write the description for the author's own PR, following the repo's template. */
export function buildDescriptionPrompt(pr: PrDetails): string {
  return `Write the description for my pull request #${pr.number} "${pr.title}". The PR head is checked out here; see the change with: git diff origin/${pr.baseRefName}...HEAD

If the repository has a pull request template (.github/pull_request_template.md, .github/PULL_REQUEST_TEMPLATE.md, docs/pull_request_template.md or a file in .github/PULL_REQUEST_TEMPLATE/), follow its sections.
Current description (keep what's accurate):
<description>
${pr.body?.trim() || "(empty)"}
</description>

Cover what changes and why, how to test it, and anything reviewers should watch for. Use Markdown, short and concrete: bullets over paragraphs, no filler, no marketing words. Don't invent issue numbers or results you can't see. Reply with only the description.`;
}

/** Asks Claude to draft the user's reply to a review conversation. */
export function buildReplyPrompt(thread: ReviewThread, me: string, author: string): string {
  const role = me === author ? "the author of this pull request" : "a reviewer of this pull request";
  return `Write my reply to this conversation on the pull request. I'm ${me}, ${role}.
It's on ${thread.path}${thread.line ? ` line ${thread.line}` : ""}; read the code there first.

${thread.comments.map((c) => `${c.author}: ${c.body}`).join("\n\n")}

Reply in 1–3 plain sentences: agree and say what will change, answer the question, or explain briefly why not. Be specific to the code; no greetings or thanks filler. Reply with only the text.`;
}
