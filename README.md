<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="BetterLGTM icon">
</p>

<h1 align="center">BetterLGTM</h1>

<p align="center">Mean it when you say lgtm.<br>A desktop app for reviewing GitHub pull requests with Claude Code.</p>

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

BetterLGTM lists the pull requests waiting for your review, checks each one out in its own git worktree, and has Claude Code compare the description with the code. You get a verdict, a short summary, and the findings that need your attention, each linked to the lines it's about. Then it walks you through the change section by section.

It runs on your machine with the `gh` and `claude` command-line tools you already have. There's no account and no server.

## Features

- **Review inbox.** Pull requests where your review is requested, directly or through a team, grouped by organization and refreshed on a timer. Switch to **Mine** for your own open pull requests. Hide the organizations you don't care about.
- **A worktree per PR.** Each pull request is checked out next to a shared clone, so Claude reads real files, not just the diff, and your own working copy is never touched.
- **Description check.** Each claim in the PR description is marked as matching, partly implemented, or contradicted by the code.
- **Findings.** Bugs, risks and gaps, ranked by severity and linked to the exact diff lines.
- **Guided review.** Related edits grouped into sections with a line on what each does, in one continuous scroll. Mark a change, a file or a whole section as reviewed and see your progress.
- **Diff view.** File-by-file unified or split diff with search, reviewed checkboxes, and generated files folded away until you open them.
- **Chat.** Ask follow-up questions; Claude knows which finding, section or file you're looking at.
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
| macOS, Apple silicon | [`BetterLGTM_0.2.4_aarch64.dmg`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_aarch64.dmg) |
| macOS, Intel | [`BetterLGTM_0.2.4_x64.dmg`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_x64.dmg) |
| Windows | [`BetterLGTM_0.2.4_x64-setup.exe`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_x64-setup.exe) or [`.msi`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_x64_en-US.msi) |
| Linux | [`.AppImage`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_amd64.AppImage), [`.deb`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM_0.2.4_amd64.deb) or [`.rpm`](https://github.com/drmas/betterlgtm/releases/download/v0.2.4/BetterLGTM-0.2.4-1.x86_64.rpm) |

On macOS you can also install it with [Homebrew](https://brew.sh):

```bash
brew install --cask drmas/tap/betterlgtm
```

The macOS app is signed with a Developer ID and notarized by Apple, so it opens like any other Mac app. Windows builds aren't signed yet: if SmartScreen warns about an unknown publisher, choose **More info › Run anyway**.

From version 0.2.1 the app updates itself: when a new release is out, choose **Install update** in the status bar.

### Requirements

- [GitHub CLI](https://cli.github.com/), signed in: `gh auth login`
- [Claude Code](https://claude.com/claude-code), signed in: run `claude` once
- `git`
- Linux: WebKitGTK 4.1 (`webkit2gtk-4.1`)

If the app can't find `gh` or `claude` (common when it's started from a launcher instead of a terminal), set their full paths in **Settings › Tools & storage**.

## Using it

1. Open the app. The inbox on the left lists the PRs waiting for your review.
2. Pick one and choose **Start review**. BetterLGTM prepares a worktree and runs Claude Code on it; results stream in as they're found.
3. Read the **Analysis** tab: the verdict, "In short", and "Needs your attention".
4. Switch to **Diff** for the guided review, and tick sections off as you go.
5. Ask questions in the Claude panel at the bottom.
6. Choose **Submit review…**. Findings you added with **Add to review** (or, if you added none, the critical and high ones) become line comments you can edit before posting.

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd> <kbd>K</kbd> | Go to a pull request, finding, section, file or command |
| <kbd>Ctrl</kbd> <kbd>1</kbd> / <kbd>Ctrl</kbd> <kbd>2</kbd> | Analysis / Diff |
| <kbd>J</kbd> / <kbd>K</kbd> | Next / previous finding |
| <kbd>Ctrl</kbd> <kbd>L</kbd> | Ask Claude |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> | Submit review |
| <kbd>Ctrl</kbd> <kbd>B</kbd> / <kbd>Ctrl</kbd> <kbd>J</kbd> | Show or hide the inbox / Claude panel |
| <kbd>F5</kbd> | Refresh review requests |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd> <kbd>/</kbd> | All shortcuts |

On macOS, use <kbd>Cmd</kbd> in place of <kbd>Ctrl</kbd>.

## Privacy and safety

- **Local only.** GitHub is reached through your `gh` and Claude through your `claude`. BetterLGTM has no backend and never sees your tokens.
- **Read-only Claude.** Claude Code runs with only these tools allowed: `Read`, `Grep`, `Glob`, `LS`, and `git log`, `git show`, `git diff`, `git blame`, `git merge-base` and `rg` through Bash. It can't edit files, run other commands, or post anything to GitHub. Reviews are posted by the app, through your `gh`, only when you press the submit button.
- **Costs.** Analyses use your Claude Code plan or API usage. The status bar shows the tokens used per PR.

### Where things are stored

| What | Where |
|---|---|
| Clones | `~/.betterlgtm/clones/<owner>/<repo>` (blobless) |
| Worktrees | `~/.betterlgtm/worktrees/<owner>/<repo>/pr-<n>` |
| Analyses, chat history, settings | The app's local storage |

You can change the data folder in Settings and clear everything from there.

## Build from source

You need Rust (stable), Node.js 22+, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/drmas/betterlgtm.git
cd betterlgtm
npm install
npm run tauri dev
```

`npm run dev` on its own opens the UI in a browser with sample data instead of `gh` and `claude`, which is handy for UI work. `npm run tauri build` makes installers for your platform.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how releases are made, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and see the [roadmap](ROADMAP.md) for what is planned. Please report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). BetterLGTM is not affiliated with GitHub or Anthropic.
