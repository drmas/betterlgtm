// Sample data so the UI can be previewed in a plain browser (`npm run dev`) without Tauri.
// Only used in development when the Tauri runtime isn't present.
import type { ClaudeEvent, PrDetails, ReviewRequest } from "./api";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const requests: ReviewRequest[] = [
  {
    number: 482,
    title: "Add idempotency keys to charge endpoint",
    url: "https://github.com/acme/payments-api/pull/482",
    isDraft: false,
    updatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    author: { login: "lkowal" },
    repository: { name: "payments-api", nameWithOwner: "acme/payments-api" },
    additions: 21,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: "REVIEW_REQUIRED",
    labels: [{ name: "payments", color: "1d76db" }],
    ci: "SUCCESS",
    files: ["src/idempotency/store.ts", "src/http/charges.ts"],
    requestedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
  },
  {
    number: 77,
    title: "Bump terraform AWS provider to 5.80",
    url: "https://github.com/acme/infra/pull/77",
    isDraft: true,
    updatedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
    author: { login: "renovate" },
    repository: { name: "infra", nameWithOwner: "acme/infra" },
    additions: 4,
    deletions: 4,
    changedFiles: 2,
    reviewDecision: "REVIEW_REQUIRED",
    labels: [{ name: "dependencies", color: "0366d6" }],
    ci: "FAILURE",
    files: ["terraform/providers.tf", ".terraform.lock.hcl"],
    requestedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
  },
];

const sinceDiff = `diff --git a/src/idempotency/store.ts b/src/idempotency/store.ts
index 2222222..5555555 100644
--- a/src/idempotency/store.ts
+++ b/src/idempotency/store.ts
@@ -17,4 +17,6 @@
 // key comes straight from the request header
 export async function save(key: string, res: CachedResponse) {
+  const locked = await redis.set(\`idem:lock:\${key}\`, "1", "NX", "EX", 30);
+  if (!locked) return waitForResponse(key);
   const existing = await redis.get(\`idem:\${key}\`);
   if (existing) return JSON.parse(existing);
`;

const mine: ReviewRequest[] = [
  {
    number: 1290,
    title: "Move invoices to the new queue",
    url: "https://github.com/acme/billing/pull/1290",
    isDraft: false,
    updatedAt: new Date(Date.now() - 5 * 3600e3).toISOString(),
    author: { login: "you" },
    repository: { name: "billing", nameWithOwner: "acme/billing" },
  },
];

const details: PrDetails = {
  number: 482,
  title: "Add idempotency keys to charge endpoint",
  body: "Adds idempotency support to POST /v1/charges.\n\n- Accepts an Idempotency-Key header on charge requests.\n- Keys are stored in Redis for 24 hours.\n- Safe to retry, even when requests arrive concurrently.\n\nTesting: added integration tests for the retry path.",
  url: "https://github.com/acme/payments-api/pull/482",
  author: { login: "lkowal" },
  isDraft: false,
  headRefName: "feat/idempotency-keys",
  baseRefName: "main",
  headRefOid: "4e1b07c9a1b2c3d4",
  additions: 21,
  deletions: 2,
  changedFiles: 2,
  reviewDecision: "REVIEW_REQUIRED",
  latestReviews: [
    { author: { login: "mchen" }, state: "APPROVED", submittedAt: new Date(Date.now() - 50 * 60e3).toISOString() },
    { author: { login: "review-bot" }, state: "COMMENTED", submittedAt: new Date(Date.now() - 90 * 60e3).toISOString() },
  ],
  reviewRequests: [{ login: "you" }, { name: "payments-team", slug: "payments-team" }],
  statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
};

const diff = `diff --git a/src/idempotency/store.ts b/src/idempotency/store.ts
index 1111111..2222222 100644
--- a/src/idempotency/store.ts
+++ b/src/idempotency/store.ts
@@ -10,7 +10,19 @@ import { redis } from "../infra/redis";
 import type { CachedResponse } from "./types";

 const TTL_SECONDS = 60 * 60 * 24;

-export async function remember() {}
+export async function lookup(key: string) {
+  const raw = await redis.get(\`idem:\${key}\`);
+  return raw ? JSON.parse(raw) : null;
+}
+
+// key comes straight from the request header
+export async function save(key: string, res: CachedResponse) {
+  const existing = await redis.get(\`idem:\${key}\`);
+  if (existing) return JSON.parse(existing);
+  await redis.set(\`idem:\${key}\`, JSON.stringify(res),
+    "EX", TTL_SECONDS);
+  return res;
+}

 export { TTL_SECONDS };
diff --git a/src/http/charges.ts b/src/http/charges.ts
index 3333333..4444444 100644
--- a/src/http/charges.ts
+++ b/src/http/charges.ts
@@ -38,4 +38,11 @@ export const router = Router();
 router.post("/v1/charges", auth, async (req, res) => {
+  const key = req.header("Idempotency-Key");
+  if (key) {
+    const hit = await lookup(key);
+    if (hit) return res.status(hit.status).json(hit.body);
+  }
   const charge = await createCharge(req.merchant, req.body);
-  res.status(201).json(serialize(charge));
+  res.status(201).json(serialize(charge));
 });
diff --git a/package-lock.json b/package-lock.json
index 5555555..6666666 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -120,6 +120,13 @@
       "integrity": "sha512-abc"
     },
+    "node_modules/ioredis": {
+      "version": "5.4.1",
+      "resolved": "https://registry.npmjs.org/ioredis/-/ioredis-5.4.1.tgz",
+      "integrity": "sha512-def",
+      "dependencies": { "cluster-key-slot": "^1.1.0" }
+    },
+    "node_modules/cluster-key-slot": { "version": "1.1.2" },
     "node_modules/zod": {
`;

const bodyHtml = `<h2 dir="auto">Summary</h2>
<p dir="auto">Adds idempotency support to <code class="notranslate">POST /v1/charges</code>. Closes <a class="issue-link" href="https://github.com/acme/payments-api/issues/471">#471</a>. cc <a class="user-mention" href="https://github.com/tchen">@tchen</a></p>
<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Accepts an <code>Idempotency-Key</code> header on charge requests.</li>
<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Keys are stored in Redis for 24 hours.</li>
<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Safe to retry, even when requests arrive concurrently.</li>
</ul>
<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p><p>Needs <code>REDIS_URL</code> in every environment before deploy.</p></div>
<details><summary>Load test results</summary>
<table><thead><tr><th>Scenario</th><th>p50</th><th>p99</th></tr></thead>
<tbody><tr><td>No key</td><td>42 ms</td><td>110 ms</td></tr><tr><td>Cached hit</td><td>8 ms</td><td>21 ms</td></tr></tbody></table>
</details>
<h3>Testing</h3>
<div class="highlight highlight-source-shell"><pre class="notranslate">npm <span class="pl-c1">test</span> -- charges.idempotency</pre></div>`;

const analysis = {
  guidelines: ["CONTRIBUTING.md"],
  risks: [{ area: "Payments", why: "Decides whether a card is charged twice.", anchors: [{ path: "src/http/charges.ts", startLine: 39, endLine: 45 }] }],
  tests: [
    { change: "Repeat requests return the cached response", covered: "yes", tests: ["test/charges.idempotency.test.ts"] },
    { change: "Two requests with the same key at once", covered: "no", tests: [], note: "No test sends concurrent requests." },
    { change: "Keys expire after 24 hours", covered: "partly", tests: ["test/store.test.ts"], note: "Checks the TTL is set, not that keys expire." },
  ],
  summary: ["Adds `Idempotency-Key` support to `POST /v1/charges`", "Caches the first response in Redis for 24 h", "Repeats with the same key get the cached response"],
  recommendation: { decision: "request_changes", reason: "Concurrent retries can still double-charge." },
  unmentioned: [
    { text: "Removes the exported `remember()` stub", anchors: [{ path: "src/idempotency/store.ts", startLine: 15, endLine: 18 }] },
    { text: "Adds `ioredis` 5.4.1 to the lockfile without a `package.json` change", anchors: [{ path: "package-lock.json", startLine: 123, endLine: 129 }] },
  ],
  claims: [
    { text: "Accepts an Idempotency-Key header on charge requests.", verdict: "implemented", anchors: [{ path: "src/http/charges.ts", startLine: 39, endLine: 43 }] },
    { text: "Keys are stored in Redis for 24 hours.", verdict: "partial", note: "The TTL is 24 hours, but keys are shared across merchants.", finding: 1, anchors: [{ path: "src/idempotency/store.ts", startLine: 23, endLine: 24 }] },
    { text: "Safe to retry, even when requests arrive concurrently.", source: "#311", verdict: "contradicted", note: "Two concurrent requests with the same key can both create a charge.", finding: 0, anchors: [] },
  ],
  findings: [
    { severity: "critical", category: "Correctness", title: "Concurrent retries can double-charge", body: ["`save()` reads and writes the key in two calls", "Two requests arriving together both miss the cache", "Both create a charge"], fix: "Reserve the key with `SET NX` before charging.", confidence: "high", anchors: [{ path: "src/idempotency/store.ts", startLine: 21, endLine: 24 }, { path: "src/http/charges.ts", startLine: 41, endLine: 42 }] },
    { severity: "high", category: "Security", title: "Idempotency keys aren't scoped to the merchant", body: "Another merchant who sends the same key gets the first merchant's cached charge back.", fix: "Prefix the key with the merchant ID.", suggestion: "  const existing = await redis.get(`idem:${merchantId}:${key}`);\n  if (existing) return JSON.parse(existing);\n  await redis.set(`idem:${merchantId}:${key}`, JSON.stringify(res),", confidence: "high", anchors: [{ path: "src/idempotency/store.ts", startLine: 19, endLine: 21 }] },
    { severity: "medium", category: "Correctness", title: "Missing key header returns 500", body: ["`lookup()` is called with `undefined` when the header is absent"], confidence: "low", anchors: [{ path: "src/http/charges.ts", startLine: 39, endLine: 40 }] },
    { severity: "low", category: "Data handling", title: "Cached response keeps the full charge body for 24 h", body: "The cached body includes card brand and last4.", confidence: "medium", anchors: [{ path: "src/http/charges.ts", startLine: 45, endLine: 45 }] },
  ],
};

/** The second pass: confirms the two real findings, disproves the third, and confirms the claim verdicts. */
const verification = {
  results: [
    { index: 0, status: "confirmed", note: "`save()` at src/idempotency/store.ts:21 reads then writes with no lock." },
    { index: 1, status: "confirmed", note: "The Redis key at src/idempotency/store.ts:19 has no merchant ID." },
    { index: 2, status: "refuted", note: "src/http/charges.ts:39 skips the lookup when the header is missing." },
  ],
  claims: [
    { index: 0, verdict: "implemented", note: "src/http/charges.ts:39 reads the header and looks it up." },
    { index: 1, verdict: "partial", note: "TTL_SECONDS is 24 h, but src/idempotency/store.ts:19 has no merchant in the key." },
    { index: 2, verdict: "contradicted", note: "save() at src/idempotency/store.ts:21 reads then writes with no lock." },
  ],
};

const walkthrough = [
  { title: "Idempotency store in Redis", why: ["New `lookup()` and `save()` keep responses for 24 h", "Replaces the empty `remember()` stub"], changes: [{ path: "src/idempotency/store.ts", startLine: 10, endLine: 28 }] },
  { title: "Charge route uses the store", why: ["Reads `Idempotency-Key` and returns cached responses", "Saves the first response after charging"], changes: [{ path: "src/http/charges.ts", startLine: 38, endLine: 48 }] },
];

/** A large synthetic diff (PR 1290) for checking diff performance. */
function bigDiff(): string {
  const out: string[] = [];
  for (let f = 0; f < 60; f++) {
    const lines = f === 0 ? 4000 : 120;
    const path = `src/module${f}/file${f}.ts`;
    out.push(`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines} +1,${lines} @@`);
    for (let i = 0; i < lines; i++) {
      if (i % 7 === 3) out.push(`-export function old${i}(a: number) { return a * ${i}; }`, `+export function renamed${i}(a: number, b = ${i}) { return a * b; }`);
      else out.push(` const value${i} = compute("${path}", ${i}); // context line`);
    }
  }
  return out.join("\n") + "\n";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent chosen in Settings, so the sample tool check answers for it. */
let mockHarness = "claude";

export async function mockInvoke(cmd: string, args: Record<string, unknown> = {}, onEvent?: (e: ClaudeEvent) => void): Promise<unknown> {
  await wait(150);
  switch (cmd) {
    case "list_review_requests":
      return requests;
    case "file_at":
      return Array.from({ length: 40 }, (_, i) => (i === 9 ? 'import { redis } from "../infra/redis";' : `// line ${i + 1}`)).join("\n");
    case "search_worktree":
      return [
        { path: "src/idempotency/store.ts", line: 13, text: "  const raw = await redis.get(`idem:${key}`);" },
        { path: "src/infra/redis.ts", line: 4, text: "export const redis = createClient({ url: process.env.REDIS_URL });" },
      ];
    case "reply_to_thread":
    case "resolve_thread":
    case "update_pr_body":
      return null;
    case "review_threads":
      return [
        { id: "T1", isResolved: false, isOutdated: false, path: "src/http/charges.ts", line: 42, startLine: null, comments: [
          { id: 1, author: "mchen", body: "Should this return 409 when the same key comes with a different body?", createdAt: new Date(Date.now() - 3 * 3600e3).toISOString(), url: "https://github.com/acme/payments-api/pull/482#discussion_r1" },
          { id: 2, author: "lkowal", body: "Good point, I'll add that check.", createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(), url: "https://github.com/acme/payments-api/pull/482#discussion_r2" },
        ] },
        { id: "T2", isResolved: true, isOutdated: true, path: "src/idempotency/store.ts", line: 12, startLine: null, comments: [
          { id: 3, author: "review-bot", body: "Consider a shorter TTL for test environments.", createdAt: new Date(Date.now() - 6 * 3600e3).toISOString(), url: "https://github.com/acme/payments-api/pull/482#discussion_r3" },
        ] },
      ];
    case "linked_issues":
      return [{ number: 311, title: "Retried charges are billed twice", body: "When a client times out and retries POST /v1/charges, the customer is charged twice.\n\nAcceptance:\n- Retrying with the same Idempotency-Key never creates a second charge\n- Works when two retries arrive at the same time", url: "https://github.com/acme/payments-api/issues/311", repository: { nameWithOwner: "acme/payments-api" } }];
    case "last_review":
      return { commitId: "9f2c41ab", state: "COMMENTED", submittedAt: new Date(Date.now() - 20 * 3600e3).toISOString() };
    case "diff_since":
      return { diff: sinceDiff, commits: [{ oid: "4e1b07c9a1b2c3d4", subject: "Lock the idempotency key while charging" }] };
    case "list_my_prs":
      return mine;
    case "submit_review":
      return "https://github.com/acme/payments-api/pull/482#pullrequestreview-1";
    case "list_orgs":
      return { login: "you", orgs: ["acme", "globex-labs", "oss-collective"] };
    case "set_config":
      mockHarness = String((args.config as { harness?: string } | undefined)?.harness || "claude");
      return null;
    case "tool_status": {
      // The browser preview can show the setup screen: add ?setup=missing or ?setup=signedout to the address.
      const setup = new URLSearchParams(location.search).get("setup");
      const picked = {
        claude: { harness: "claude", agentName: "Claude Code", agent: "2.1.318 (Claude Code)", agentFile: "/home/you/.local/bin/claude", agentAccount: { signedIn: true, method: "claude.ai", plan: "max", email: "you@example.com" } },
        codex: { harness: "codex", agentName: "Codex", agent: "codex-cli 0.166.0", agentFile: "/home/you/.local/bin/codex", agentAccount: { signedIn: true, method: "ChatGPT" } },
        gemini: { harness: "gemini", agentName: "Gemini CLI", agent: undefined, agentError: "Could not run `gemini`: No such file or directory (os error 2). Is it installed and on PATH?", agentFile: null, agentAccount: {} },
      }[mockHarness] ?? { harness: "claude" };
      const ok = {
        gh: "gh version 2.103.3 (2026-10-26)", ghFile: "/usr/bin/gh", login: "you",
        ...picked,
        agents: [
          { id: "claude", name: "Claude Code", file: "/home/you/.local/bin/claude" },
          { id: "codex", name: "Codex", file: "/home/you/.local/bin/codex" },
          { id: "gemini", name: "Gemini CLI", file: null },
        ],
        git: "git version 2.56.0", dataDir: "/home/you/.betterlgtm",
      };
      await wait(400);
      if (setup === "missing") return { ...ok, gh: undefined, login: undefined, ghError: "Could not run `gh`: No such file or directory (os error 2). Is it installed and on PATH?", agent: undefined, agentFile: null, agentAccount: {}, agents: ok.agents.map((a) => ({ ...a, file: null })), ghFile: null, agentError: "Could not run `claude`: No such file or directory (os error 2). Is it installed and on PATH?" };
      if (setup === "signedout") return { ...ok, login: undefined, loginError: "`gh api user --jq .login` failed: To get started with GitHub CLI, please run: gh auth login", agentAccount: { signedIn: false } };
      return ok;
    }
    case "pr_details":
      return args.number === 1290
        ? {
            ...details,
            number: 1290,
            title: mine[0].title,
            url: mine[0].url,
            author: { login: "you" },
            headRefName: "invoices-queue",
            reviewDecision: "CHANGES_REQUESTED",
            latestReviews: [{ author: { login: "mchen" }, state: "CHANGES_REQUESTED", submittedAt: new Date(Date.now() - 3 * 3600e3).toISOString() }],
            reviewRequests: [],
            statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }],
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
          }
        : details;
    case "pr_diff":
      // VITE_MOCK_BIG=1 swaps in a 60-file diff for checking diff performance.
      return args.number === 1290 && import.meta.env.VITE_MOCK_BIG === "1" ? bigDiff() : diff;
    case "pr_body_html":
      return bodyHtml;
    case "prepare_worktree":
      return "/home/you/.betterlgtm/worktrees/acme/payments-api/pr-482";
    case "claude_run": {
      onEvent?.({ type: "system", subtype: "init", session_id: "mock-session" });
      for (const name of ["Read", "Grep", "Bash"]) {
        await wait(300);
        onEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", name, input: { file_path: "src/idempotency/store.ts", pattern: "redis", command: "git diff origin/main...HEAD" } }] } });
      }
      const prompt = String(args.prompt ?? "");
      const isAnalysis = prompt.includes("You are helping a developer review pull request");
      const isVerify = prompt.includes("double-checking a code review");
      const isGuide = !isAnalysis && prompt.includes("guided review");
      const isRecheck = prompt.includes("Re-check each finding");
      const isSummary = prompt.includes("overall summary for the GitHub review");
      const isDescription = prompt.includes("Write the description for my pull request");
      const isReply = prompt.includes("Write my reply to this conversation");
      const recheck = {
        results: [
          { index: 0, status: "fixed", note: "save() now takes a lock with SET NX before charging, so a second request waits." },
          { index: 1, status: "open", note: "Keys are still stored as idem:{key} without the merchant ID." },
          { index: 2, status: "unclear", note: "The cached body didn't change; it depends on what the client needs." },
        ],
      };
      const result = isReply
        ? "Good catch. I'll return 409 when the same key comes with a different body, and add a test for it."
        : isDescription
        ? "## What\n\n- Moves invoice delivery from the cron job to the new `invoices` queue\n- Retries failed deliveries with backoff\n\n## Why\n\nThe cron job dropped invoices when the mail provider timed out.\n\n## How to test\n\n- `npm test -- invoices`\n- Send a test invoice in staging and check the queue dashboard\n\n## Watch for\n\n- The old cron entry is removed in the same deploy"
        : isSummary
        ? "Thanks for adding idempotency keys. Two things need to change before this is safe: concurrent requests with the same key can still both charge the card, and keys aren't scoped to the merchant. Happy to look again once those are fixed."
        : isRecheck
        ? "```json\n" + JSON.stringify(recheck) + "\n```"
        : isVerify
        ? "```json\n" + JSON.stringify(verification) + "\n```"
        : isAnalysis
        ? "```json\n" + JSON.stringify(analysis) + "\n```"
        : isGuide
          ? "```json\n" + JSON.stringify({ walkthrough }) + "\n```"
          : "ok";
      onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: isAnalysis || isGuide || isRecheck || isVerify ? "Done." : "This is a sample answer from the browser preview." }] } });
      onEvent?.({ type: "result", session_id: "mock-session", result, usage: { input_tokens: 12000, output_tokens: 900 } });
      return null;
    }
    default:
      return null;
  }
}
