# Contributing to BetterLGTM

Thanks for helping. This guide covers how to get the app running, how the code is laid out, and what a good pull request looks like.

## Ways to help

- **Report a bug.** Open an [issue](https://github.com/drmas/betterlgtm/issues/new/choose) with your OS, the app version (Help › About), and what you expected to happen.
- **Suggest a feature.** Open an issue first so we can agree on the shape before you write code. [docs/FEATURES.md](docs/FEATURES.md) lists ideas that are already planned.
- **Send a pull request.** Small, focused changes are easiest to review.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

You need:

- Rust (stable) and Node.js 22+
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (WebKitGTK 4.1 on Linux, WebView2 on Windows, Xcode command-line tools on macOS)
- `gh` and `claude` installed and signed in, to try the real thing

```bash
npm install
npm run tauri dev
```

### Sample-data mode

```bash
npm run dev
```

This opens the UI at http://localhost:1420 in a normal browser. Outside Tauri, every backend call is answered from `src/mock.ts`, including a streamed analysis and a guided review, so you can work on the interface without `gh`, `claude` or a real repository. Keep the sample data realistic when you add features.

## Project layout

```
src/                  React + TypeScript frontend
  App.tsx             State, commands (menus, shortcuts, palette) and layout
  api.ts              Typed wrappers around Tauri commands, with the mock fallback
  analysis.ts         Prompts sent to Claude and parsing of its answers
  components/         UI: Inbox, AnalysisView, GuidedReview, DiffView, ClaudePanel, Settings…
  settings.ts         Settings type, defaults and migration
  sessions.ts         Per-PR state kept in local storage
  mock.ts             Sample data for browser mode
src-tauri/            Rust backend (Tauri 2)
  src/gh.rs           Calls to the GitHub CLI
  src/worktree.rs     Clones and per-PR worktrees
  src/claude.rs       Runs `claude -p` and streams its events to the UI
  src/config.rs       Tool paths, data folder, model settings
docs/                 Architecture notes, feature list, screenshots
release-notes/        One file per release, used as the GitHub release body
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how a review flows through these pieces.

## Before you open a pull request

```bash
npx tsc --noEmit
(cd src-tauri && cargo check && cargo clippy)
```

- Match the style of the code around your change. Keep comments to the why, not the what.
- Claude must stay read-only. Don't add tools to `ALLOWED_TOOLS` in `src-tauri/src/claude.rs` that can write files, run arbitrary commands or reach the network.
- Never store GitHub or Anthropic credentials. Authentication belongs to `gh` and `claude`.
- Check your change in a narrow window (around 600 px) and in both themes.
- UI text uses sentence case and plain words. Buttons say what they do.
- Include a screenshot or short recording for visible changes.

Write commit messages in the imperative ("Add split diff search"), with a short body explaining why when it isn't obvious.

## Releasing

Maintainers only:

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Add `release-notes/v<version>.md` and a section in `CHANGELOG.md`.
3. Commit, then tag and push: `git tag -a v<version> -m "BetterLGTM <version>" && git push origin v<version>`.

The [Release workflow](.github/workflows/release.yml) builds macOS (Apple silicon and Intel), Windows and Linux installers, attaches them to a GitHub release with those notes, and publishes it once every build succeeds.

macOS builds are signed and notarized when the Apple secrets are set; see [docs/SIGNING.md](docs/SIGNING.md). Once the release is published, the Homebrew cask is updated to it; see [docs/HOMEBREW.md](docs/HOMEBREW.md).

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
