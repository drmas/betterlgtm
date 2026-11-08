"""Writes the Homebrew cask for a release into a checkout of the tap repository.

Usage: homebrew-cask.py <tap-dir>

Run in CI with GH_TOKEN, GITHUB_REPOSITORY and TAG set. Checksums come from the digests GitHub
stores for each release asset. Fails if either macOS DMG is missing, so the cask never points at
a file that isn't there.
"""

import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ARCHES = {"arm": "aarch64", "intel": "x64"}


def gh(*args):
    out = subprocess.run(["gh", "api", *args], check=True, capture_output=True).stdout
    return json.loads(out)


def sha256(asset):
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        return digest.removeprefix("sha256:")
    # Older assets have no stored digest; hash the download instead.
    with urllib.request.urlopen(asset["browser_download_url"]) as r:
        return hashlib.file_digest(r, "sha256").hexdigest()


tap_dir = Path(sys.argv[1])
repo = os.environ["GITHUB_REPOSITORY"]
tag = os.environ["TAG"]
version = tag.removeprefix("v")
release = gh(f"repos/{repo}/releases/tags/{tag}")
assets = {a["name"]: a for a in release["assets"]}

sums = {}
for arch, suffix in ARCHES.items():
    name = f"BetterLGTM_{version}_{suffix}.dmg"
    if name not in assets:
        raise SystemExit(f"Missing {name} in release {tag}")
    sums[arch] = sha256(assets[name])

cask = f'''cask "betterlgtm" do
  arch arm: "aarch64", intel: "x64"

  version "{version}"
  sha256 arm:   "{sums["arm"]}",
         intel: "{sums["intel"]}"

  url "https://github.com/{repo}/releases/download/v#{{version}}/BetterLGTM_#{{version}}_#{{arch}}.dmg"
  name "BetterLGTM"
  desc "Review GitHub pull requests with Claude Code"
  homepage "https://drmas.github.io/betterlgtm/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app installs its own updates from the status bar.
  auto_updates true
  depends_on :macos

  app "BetterLGTM.app"

  zap trash: [
    "~/Library/Application Support/io.weekone.betterlgtm",
    "~/Library/Caches/io.weekone.betterlgtm",
    "~/Library/Preferences/io.weekone.betterlgtm.plist",
    "~/Library/Saved Application State/io.weekone.betterlgtm.savedState",
    "~/Library/WebKit/io.weekone.betterlgtm",
  ]
end
'''

path = tap_dir / "Casks" / "betterlgtm.rb"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(cask)
print(f"{path}: {version}")
