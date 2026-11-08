# Architecture

BetterLGTM is a [Tauri 2](https://v2.tauri.app/) app: a Rust backend that runs command-line tools, and a React + TypeScript frontend in the system webview. There is no server. Everything the app knows comes from three local tools:

| Tool | Used for |
|---|---|
| `gh` | Listing review requests and organizations, PR details, the diff, and the description rendered as GitHub HTML |
| `git` | A blobless clone per repository and a worktree per pull request |
| `claude` | The analysis, the guided review and the chat, run read-only inside the worktree |

## Reviewing a pull request

```
Inbox ──gh search prs──▶ list of review requests
  │ pick one
  ▼
pr_details + pr_diff + pr_body_html   (gh pr view / gh pr diff / gh api)
  │ Start review
  ▼
prepare_worktree                       (git clone --filter=blob:none, git fetch pull/<n>/head, git worktree)
  │
  ▼
claude_run in the worktree             (claude -p --output-format stream-json)
  │ events streamed over a Tauri channel
  ▼
parse analysis → verdict, claims, findings ──▶ AnalysisView
  │ Diff tab
  ▼
claude_run (walkthrough prompt) → sections ──▶ GuidedReview
  │
  ▼
chat: claude_run --resume <session>    ──▶ ClaudePanel
```

### 1. Inbox

`gh::list_review_requests` runs `gh search prs "user-review-requested:@me"` (or `review-requested:@me` to include team requests) and returns JSON. The frontend filters it by the organizations chosen in Settings and refreshes it on a timer.

### 2. Worktree

`worktree::prepare_worktree` keeps one blobless clone per repository under `<data>/clones/<owner>/<repo>`. For each PR it fetches `pull/<n>/head` into `refs/better-lgtm/pr-<n>`, so pull requests from forks work too, and checks it out detached in `<data>/worktrees/<owner>/<repo>/pr-<n>`. Running it again updates the worktree to the PR's latest head.

### 3. Claude

`claude::claude_run` starts `claude -p` in the worktree with:

- `--output-format stream-json --verbose`, so each event (text, tool use, usage) is forwarded to the UI as it happens over a `tauri::ipc::Channel`;
- `--allowedTools` limited to `Read`, `Grep`, `Glob`, `LS` and a few read-only `git` and `rg` commands, plus `--disallowedTools` for anything that writes;
- `--append-system-prompt` asking for short, bulleted answers;
- `--model` and `--effort` from Settings;
- `--resume <session id>` for follow-up chat messages, which keeps the conversation going across app restarts.

Runs can be cancelled; the backend keeps a cancel handle per run id.

### 4. Turning answers into UI

`src/analysis.ts` builds the prompts and parses Claude's answers. The analysis prompt asks for a fixed structure (verdict, summary, claims, findings with file and line ranges); the parser is tolerant of small deviations. The walkthrough prompt returns ordered sections, each with a summary and the hunks it covers.

`src/diffUtils.ts` maps findings and sections to hunks of the parsed diff (via `react-diff-view`), and identifies generated files so they can be folded.

## Frontend state

- **Per-PR sessions** (`src/sessions.ts`): analysis results, walkthrough, chat history, Claude session ids and reviewed hunks, kept in local storage under `better-lgtm.sessions`. A hunk's review state is keyed by its file path and content, so it survives refreshes but resets when the code changes.
- **Settings** (`src/settings.ts`): theme, organizations, refresh interval, diff options, Claude model and effort, review instructions, tool paths and data folder. Tool paths, data folder and model are pushed to the backend with `set_config`.
- **Commands** (`src/commands.ts`, `App.tsx`): one list of commands drives the menu bar, keyboard shortcuts and the command palette, so they never disagree.

## Browser mode

`src/api.ts` calls Tauri commands when running inside Tauri, and `src/mock.ts` otherwise (in development). The mock answers every command, including a streamed analysis, so `npm run dev` shows the whole UI in a browser.

## Rendering untrusted content

PR descriptions are rendered from GitHub's HTML and sanitized with DOMPurify (allowing `<details>` and `<summary>`). Claude's answers are rendered as Markdown with `react-markdown`, without raw HTML. Links open in the system browser.

## Releases

`.github/workflows/release.yml` runs on version tags. It creates a draft release with the notes from `release-notes/<tag>.md`, builds installers on macOS (arm64 and x64), Windows and Linux with `tauri-action`, uploads them, and publishes the release once every build succeeds. It then starts `.github/workflows/homebrew.yml`, which points the cask in `drmas/homebrew-tap` at the new release ([HOMEBREW.md](HOMEBREW.md)).
