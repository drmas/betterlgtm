<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="BetterLGTM icon">
</p>

<h1 align="center">BetterLGTM</h1>

<p align="center">Mean it when you say lgtm.<br>A desktop app for reviewing GitHub pull requests with Claude Code, Codex or Gemini CLI.</p>

<p align="center">
  <a href="https://drmas.github.io/betterlgtm/">Website</a> ·
  <a href="https://github.com/drmas/betterlgtm/releases/latest">Download</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-dark.png">
  <img src="docs/screenshots/analysis-light.png" alt="BetterLGTM showing a pull request analysis: a request-changes verdict, a short summary, and the findings and description claims that need attention">
</picture>

BetterLGTM lists the pull requests waiting for your review, checks each one out in its own git worktree, and has your coding agent (Claude Code, Codex or Gemini CLI) compare the description with the code. You get a verdict, a short summary, and the findings that need your attention, each linked to the lines it's about. A second pass double-checks each finding against the code, and then it walks you through the change section by section.

It runs on your machine with the `gh` and agent command-line tools you already have. There's no account and no server.

## Features

- **Your choice of agent.** Run reviews with Claude Code, Codex or Gemini CLI (experimental). Pick one during setup or in **Settings › Agent**; each runs read-only.
- **Guided setup.** The first run checks `gh`, your agent and `git`, shows the command that fixes anything missing or signed out, and lets you choose what the inbox shows. **Try a sample pull request** shows a finished review without any of them.
- **Review inbox.** Pull requests where your review is requested, directly or through a team, grouped by organization and refreshed on a timer. Switch to **Mine** for your own open pull requests. Each row shows CI, review state, size and a risk estimate, and **Sort and filter** sorts by risk, waiting time, size or last update, filters by CI, risk, review decision and analysis, and picks which organizations and repositories to show. Your choices are kept. A desktop notification and a count on the app icon tell you when a review is requested or requested again. Hide the organizations you don't care about.
- **A worktree per PR.** Each pull request is checked out next to a shared clone, so the agent reads real files, not just the diff, and your own working copy is never touched.
- **Auto-analyze (optional).** New review requests can be analyzed in the background, so results are waiting when you open them. A spending limit ($5 by default, Claude Code only) stops any that run long.
- **Description check.** Each claim in the PR description is marked as matching, partly implemented, or contradicted by the code, and the double-check corrects verdicts the code doesn't support. Changes the description doesn't mention are listed next to the claims, with their lines.
- **Findings.** Bugs, risks and gaps, ranked by severity and linked to the exact diff lines. Resolve or dismiss them, and post fixes as suggestions the author can apply. Each finding is checked again in a fresh session: confirmed ones are marked **Double-checked**, and ones it disproves are set aside where you can still see them.
- **Risk and tests.** The risk level and its reasons, the sensitive areas touched, and whether each change is tested.
- **Context.** The issues the PR closes and the conversations already on it, so findings don't repeat what reviewers said, along with what your last review found and what you dismissed in the same repository. The overview lists which of those dismissals were used, and only the same point in the same file is held back.
- **Guided review.** Related edits grouped into sections with a line on what each does, in one continuous scroll. Mark a change, a file or a whole section as reviewed and see your progress.
- **Since your last review.** When new commits land after you reviewed, see just those changes and analyze only them.
- **Re-check findings.** After the author pushes, the agent checks which findings are fixed and which are still open.
- **Diff view.** File-by-file unified or split diff with syntax highlighting, hidden lines on demand, whitespace hiding, regex search across the diff and the repository, line comments, and generated files folded away until you open them.
- **Your own PRs.** See what's blocking merge, self-review before asking for reviews, have the agent write the description, and reply to feedback.
- **Chat.** Ask follow-up questions; the agent knows which finding, section or file you're looking at.
- **Submit review.** Post your review to GitHub with the findings you pick as comments on their lines. Edit each comment, add a summary, and choose Comment, Approve or Request changes.
- **Desktop ergonomics.** Menu bar, command palette, keyboard shortcuts, light and dark themes, and layouts that work in narrow windows.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/guided-dark.png">
  <img src="docs/screenshots/guided-light.png" alt="Guided review: the change split into three sections, each with a short summary above the diff of its file">
</picture>

## Install

Download the installer for your platform from [Releases](https://github.com/drmas/betterlgtm/releases/latest).

| Platform | File |
|---|---|
| macOS, Apple silicon | [`BetterLGTM_0.6.1_aarch64.dmg`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_aarch64.dmg) |
| macOS, Intel | [`BetterLGTM_0.6.1_x64.dmg`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_x64.dmg) |
| Windows | [`BetterLGTM_0.6.1_x64-setup.exe`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_x64-setup.exe) or [`.msi`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_x64_en-US.msi) |
| Linux | [`.AppImage`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_amd64.AppImage), [`.deb`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM_0.6.1_amd64.deb) or [`.rpm`](https://github.com/drmas/betterlgtm/releases/download/v0.6.1/BetterLGTM-0.6.1-1.x86_64.rpm) |

On macOS you can also install it with [Homebrew](https://brew.sh):

```bash
brew install --cask drmas/tap/betterlgtm
```

The macOS app is signed with a Developer ID and notarized by Apple, so it opens like any other Mac app. Windows builds aren't signed yet: if SmartScreen warns about an unknown publisher, choose **More info › Run anyway**.

From version 0.2.1 the app updates itself: when a new release is out, choose **Install update** in the status bar.

### Requirements

- [GitHub CLI](https://cli.github.com/), signed in: `gh auth login`
- One coding agent, signed in:
  - [Claude Code](https://claude.com/claude-code): `claude auth login`
  - [Codex](https://developers.openai.com/codex/cli): `codex login`
  - [Gemini CLI](https://geminicli.com) (experimental): run `gemini` once and choose how to sign in
- `git`
- Linux: WebKitGTK 4.1 (`webkit2gtk-4.1`)

The app checks these on first run and shows how to fix anything missing. If it can't find `gh` or your agent (common when it's started from a launcher instead of a terminal), set their full paths in **Settings › Tools & storage** or **Settings › Agent**.

## Using it

1. Open the app. On first run, follow the three setup steps, or try the sample pull request. The inbox on the left lists the PRs waiting for your review.
2. Pick one and choose **Start review**. BetterLGTM prepares a worktree and runs your agent on it; results stream in as they're found, then each finding is double-checked.
3. Read the **Analysis** tab: the verdict, "In short", and "Needs your attention".
4. Switch to **Diff** for the guided review, and tick sections off as you go.
5. Ask questions in the agent's panel at the bottom.
6. Choose **Submit review…**. Findings you added with **Add to review** (or, if you added none, the critical and high ones) become line comments you can edit before posting.

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd> <kbd>K</kbd> | Go to a pull request, finding, section, file or command |
| <kbd>Ctrl</kbd> <kbd>1</kbd> / <kbd>Ctrl</kbd> <kbd>2</kbd> | Analysis / Diff |
| <kbd>Ctrl</kbd> <kbd>L</kbd> | Ask the agent |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> | Submit review |
| <kbd>Ctrl</kbd> <kbd>B</kbd> / <kbd>Ctrl</kbd> <kbd>J</kbd> | Show or hide the inbox / agent panel |
| <kbd>F5</kbd> | Refresh review requests |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd> <kbd>/</kbd> | All shortcuts |

On macOS, use <kbd>Cmd</kbd> in place of <kbd>Ctrl</kbd>.

**Vim-style keys** work whenever no text field has focus: <kbd>h</kbd> / <kbd>l</kbd> move between the inbox, the list and the content, <kbd>j</kbd> / <kbd>k</kbd> move inside a pane, <kbd>g</kbd><kbd>g</kbd> / <kbd>G</kbd> jump to the top or bottom, <kbd>n</kbd> / <kbd>N</kbd> step through findings, <kbd>x</kbd> marks the current file or section reviewed, and <kbd>S</kbd> submits the review. Press <kbd>?</kbd> for the full list, or turn them off in Settings › General.

## Privacy and safety

- **Local only.** GitHub is reached through your `gh` and the model through your own agent CLI. BetterLGTM has no backend and never sees your tokens.
- **Anonymous usage stats.** Release builds send counts of app opens, analyses, submitted reviews and a few other actions to PostHog, with the app version, operating system and a random ID made on your computer. They never include code, findings, chat, PR descriptions, or repository, organization, PR or account names. Turn it off in **Settings › General › Share anonymous usage stats**. Builds from source send nothing. The full list of events is in [`src/telemetry.ts`](src/telemetry.ts).
- **Read-only agents.** Claude Code runs with only these tools allowed: `Read`, `Grep`, `Glob`, `LS`, and `git log`, `git show`, `git diff`, `git blame`, `git merge-base` and `rg` through Bash. Codex runs in its read-only sandbox, and may search the web. Gemini CLI runs in its read-only plan mode. None of them can edit files or post anything to GitHub. Reviews are posted by the app, through your `gh`, only when you press the submit button.
- **Costs.** Analyses use your agent's plan or API usage. The status bar shows the tokens used per PR.

### Where things are stored

| What | Where |
|---|---|
| Clones | `~/.betterlgtm/clones/<owner>/<repo>` (blobless) |
| Worktrees | `~/.betterlgtm/worktrees/<owner>/<repo>/pr-<n>` |
| Analyses and chat history | `sessions/` in the app's data folder, one file per PR |
| Settings and the anonymous install ID | The app's local storage |

You can change the data folder in Settings and clear everything from there.

## Build from source

You need Rust (stable), Node.js 22+, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/drmas/betterlgtm.git
cd betterlgtm
npm install
npm run tauri dev
```

`npm run dev` on its own opens the UI in a browser with sample data instead of `gh` and an agent, which is handy for UI work. `npm run tauri build` makes installers for your platform.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how releases are made, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and see the [roadmap](ROADMAP.md) for what is planned. Please report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). BetterLGTM is not affiliated with GitHub, Anthropic, OpenAI or Google.
