# Homebrew

macOS users can install BetterLGTM with:

```bash
brew install --cask drmas/tap/betterlgtm
```

The cask lives in a separate tap repository, [`drmas/homebrew-tap`](https://github.com/drmas/homebrew-tap), at `Casks/betterlgtm.rb`. It installs the signed and notarized DMG for the Mac's chip (Apple silicon or Intel) from the GitHub release.

The cask sets `auto_updates true`, because the app installs its own updates. `brew upgrade` skips it unless you pass `--greedy`, so Homebrew doesn't fight the built-in updater. `brew uninstall --zap --cask betterlgtm` also removes the app's settings and caches.

## How the cask is updated

After the [Release workflow](../.github/workflows/release.yml) publishes a release, it starts the [Homebrew workflow](../.github/workflows/homebrew.yml). That workflow runs [`scripts/homebrew-cask.py`](../scripts/homebrew-cask.py), which writes the cask with the new version and the SHA-256 of both DMGs, then pushes it to the tap.

If the `HOMEBREW_TAP_TOKEN` secret is missing, the workflow logs a warning and does nothing. The release itself isn't affected.

## One-time setup

1. **Create the tap.** Make a public repository named `homebrew-tap` under `drmas`, with a README so it has a `main` branch:

   ```bash
   gh repo create drmas/homebrew-tap --public --add-readme \
     --description "Homebrew tap for BetterLGTM"
   ```

2. **Create a token.** On GitHub, go to **Settings › Developer settings › Fine-grained tokens** and create a token with:
   - Resource owner: `drmas`
   - Repository access: only `drmas/homebrew-tap`
   - Permissions: **Contents: Read and write**

3. **Store it as a secret.** Save the token in 1Password, then paste it into the prompt this command shows, so it never ends up in your shell history:

   ```bash
   gh secret set HOMEBREW_TAP_TOKEN -R drmas/betterlgtm
   ```

4. **Write the first cask.** Run the workflow for the current release:

   ```bash
   gh workflow run homebrew.yml -R drmas/betterlgtm -f tag=v0.2.4
   ```

5. **Check it.**

   ```bash
   brew install --cask drmas/tap/betterlgtm
   brew audit --cask --strict --online drmas/tap/betterlgtm
   ```

Fine-grained tokens expire. When the token runs out, the Homebrew workflow fails at checkout: create a new token and repeat step 3.

## Fixing the cask by hand

To rewrite the cask for a tag that's already published, for example after a failed run, run step 4 again with that tag. To change the cask's contents, edit `scripts/homebrew-cask.py` rather than the tap. The next run overwrites the tap's copy.
