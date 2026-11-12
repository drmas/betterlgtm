import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { HarnessId } from "./harness";
import { inTauri, mockInvoke } from "./mock";

// Outside Tauri (browser preview during development, or a VITE_MOCK=1 build) the backend is replaced by sample data.
const useMock = !inTauri && (import.meta.env.DEV || import.meta.env.VITE_MOCK === "1");
/** The backend itself, whatever the sample mode: tool checks and settings are always about this computer. */
const real = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  useMock ? (mockInvoke(cmd, args) as Promise<T>) : tauriInvoke<T>(cmd, args);

// Sample mode: the app shows the built-in sample pull requests, so someone can try a review
// before gh and claude are set up. Nothing reaches GitHub or Claude while it's on.
let sample = false;
export function setSampleMode(on: boolean) {
  sample = on;
}
export const isSampleMode = () => sample;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => (sample ? (mockInvoke(cmd, args) as Promise<T>) : real<T>(cmd, args));

/** Whether the tools the app runs are installed and signed in. */
export interface ToolStatus {
  gh?: string;
  ghError?: string;
  /** The GitHub account gh is signed in to. */
  login?: string;
  /** Set when gh runs but GitHub didn't answer for the account: signed out, or offline. */
  loginError?: string;
  /** The file the gh command resolves to. */
  ghFile?: string | null;
  /** The agent chosen to run reviews (claude, codex, gemini or copilot) and its name. */
  harness?: string;
  agentName?: string;
  /** The chosen agent's version, or why it couldn't run. */
  agent?: string;
  agentError?: string;
  /** The file the agent's command resolves to. */
  agentFile?: string | null;
  /** How the agent is signed in, so it's clear which account the analyses use. `signedIn` is missing when it can't say. */
  agentAccount?: { signedIn?: boolean | null; method?: string | null; plan?: string | null; email?: string | null };
  /** Every agent the app can run and where each was found on this computer; `file` is null when it wasn't. */
  agents?: { id: string; name: string; file: string | null }[];
  git?: string;
  gitError?: string;
  dataDir: string;
}

export interface ReviewRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string };
  repository: { name: string; nameWithOwner: string };
  createdAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  labels?: { name: string; color: string }[];
  /** Combined state of the head commit's checks; null when there are none. */
  ci?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  /** Up to the first 100 changed paths, for the risk estimate. */
  files?: string[];
  /** When your review was last requested. */
  requestedAt?: string | null;
}

/** A conversation already on the PR, attached to a line of a file. */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: { id: number; author: string; body: string; createdAt: string; url: string }[];
}

/** An issue the PR closes. */
export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  repository: { nameWithOwner: string };
}

/** Your most recent submitted review on a PR, and the commit it was made on. */
export interface LastReview {
  commitId: string;
  state: Review["state"];
  submittedAt: string;
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** A review comment on the new version of a file; `line` (and `start_line`) must be inside the diff. */
export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  body: string;
}

export interface CheckRun {
  conclusion?: string;
  status?: string;
  state?: string;
  /** Check runs have a name; commit statuses have a context. */
  name?: string;
  context?: string;
}

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  author: { login: string };
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  statusCheckRollup: CheckRun[];
  /** Empty when the repository doesn't require reviews. */
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  /** Each reviewer's most recent review. */
  latestReviews?: Review[];
  /** Reviewers who were asked and haven't reviewed since: users have a login, teams a name. */
  reviewRequests?: { login?: string; name?: string; slug?: string }[];
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus?: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
}

export interface Review {
  author: { login: string };
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt?: string;
}

/** One line of `claude -p --output-format stream-json`. Only the fields we read are typed. */
export interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
  result?: string;
  /** The answer as data, when the run was given a schema. */
  structured_output?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  text?: string;
}

export interface ClaudeRunOptions {
  /** A chat answer: adds the short-answer style for the side panel. */
  chat?: boolean;
  /** JSON Schema the final answer must match; it arrives as `structured_output` on the result. */
  schema?: object;
  /** Stops the run when it has cost this much. */
  maxBudgetUsd?: number;
  /** Run this one call on another agent than the configured one, with that agent's own model and effort. */
  harness?: HarnessId;
}

export const api = {
  listReviewRequests: (includeTeams: boolean) => invoke<ReviewRequest[]>("list_review_requests", { includeTeams }),
  listMyPrs: () => invoke<ReviewRequest[]>("list_my_prs"),
  lastReview: (repo: string, number: number, login: string) => invoke<LastReview | null>("last_review", { repo, number, login }),
  diffSince: (repo: string, number: number, baseRef: string, since: string) =>
    invoke<{ diff: string; commits: { oid: string; subject: string }[] }>("diff_since", { repo, number, baseRef, since }),
  linkedIssues: (repo: string, number: number) => invoke<LinkedIssue[]>("linked_issues", { repo, number }),
  reviewThreads: (repo: string, number: number) => invoke<ReviewThread[]>("review_threads", { repo, number }),
  updatePrBody: (repo: string, number: number, body: string) => invoke<void>("update_pr_body", { repo, number, body }),
  replyToThread: (repo: string, number: number, commentId: number, body: string) => invoke<void>("reply_to_thread", { repo, number, commentId, body }),
  resolveThread: (threadId: string, resolve: boolean) => invoke<void>("resolve_thread", { threadId, resolve }),
  fileAt: (repo: string, sha: string, path: string) => invoke<string>("file_at", { repo, sha, path }),
  searchWorktree: (cwd: string, pattern: string, regex: boolean, caseSensitive: boolean) =>
    invoke<{ path: string; line: number; text: string }[]>("search_worktree", { cwd, pattern, regex, caseSensitive }),
  listOrgs: () => invoke<{ login: string; orgs: string[] }>("list_orgs"),
  setConfig: (config: { ghPath: string; claudePath: string; harness: string; codexPath: string; geminiPath: string; copilotPath: string; dataDir: string; model: string; effort: string }) =>
    real<void>("set_config", { config }),
  toolStatus: () => real<ToolStatus>("tool_status"),
  prDetails: (repo: string, number: number) => invoke<PrDetails>("pr_details", { repo, number }),
  prDiff: (repo: string, number: number) => invoke<string>("pr_diff", { repo, number }),
  prBodyHtml: (repo: string, number: number) => invoke<string>("pr_body_html", { repo, number }),
  submitReview: (repo: string, number: number, review: { commitId: string; event: ReviewEvent; body: string; comments: ReviewComment[] }) =>
    invoke<string>("submit_review", { repo, number, ...review }),
  prepareWorktree: (repo: string, number: number, baseRef: string) =>
    invoke<string>("prepare_worktree", { repo, number, baseRef }),
  claudeRun: (runId: string, cwd: string, prompt: string, resume: string | undefined, onEvent: (e: ClaudeEvent) => void, opts: ClaudeRunOptions = {}) => {
    if (useMock || sample) {
      return mockInvoke("claude_run", { runId, cwd, prompt }, onEvent) as Promise<void>;
    }
    const start = (schema?: object) => {
      const channel = new Channel<ClaudeEvent>();
      channel.onmessage = onEvent;
      return invoke<void>("claude_run", {
        runId,
        cwd,
        prompt,
        resume: resume ?? null,
        chat: !!opts.chat,
        schema: schema ? JSON.stringify(schema) : null,
        maxBudgetUsd: opts.maxBudgetUsd && opts.maxBudgetUsd > 0 ? opts.maxBudgetUsd : null,
        harness: opts.harness ?? null,
        onEvent: channel,
      });
    };
    // A Claude Code from before --json-schema stops at once; run again and read the JSON from its text.
    return start(opts.schema).catch((e) => {
      if (opts.schema && /unknown option.*json-schema/i.test(errorText(e))) return start();
      throw e;
    });
  },
  claudeCancel: (runId: string) => invoke<void>("claude_cancel", { runId }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Short description of a tool call, for progress lines and the chat transcript. */
export function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Read":
      return `Read ${s("file_path")}`;
    case "Grep":
      return `Searched for ${s("pattern")}`;
    case "Glob":
      return `Listed ${s("pattern")}`;
    case "Bash":
      return `Ran ${s("command")}`;
    default:
      return name;
  }
}
