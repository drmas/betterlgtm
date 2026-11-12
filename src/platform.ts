import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac, isWindows } from "./commands";
import { inTauri } from "./mock";
import { isSettingsWindow } from "./settingsWindow";

export const os = isMac ? "mac" : isWindows ? "windows" : "linux";

/**
 * Tag the page with the platform and window effects, so styles can follow each system's look:
 * `data-os` (mac, windows, linux), `data-vibrancy` when the sidebar shows the desktop through it,
 * and `data-fullscreen` on macOS, where the traffic lights hide in full screen.
 */
export function setupPlatform() {
  const root = document.documentElement;
  root.dataset.os = os;
  if (!inTauri) return;
  if (isMac) {
    // The macOS window is transparent with the sidebar material behind it (tauri.macos.conf.json).
    if (!isSettingsWindow) root.dataset.vibrancy = "";
    const win = getCurrentWindow();
    const sync = () => win.isFullscreen().then((f) => (f ? (root.dataset.fullscreen = "") : delete root.dataset.fullscreen)).catch(() => {});
    sync();
    win.onResized(sync);
  } else if (isWindows && !isSettingsWindow) {
    // Mica needs Windows 11, which reports platform version 13 or later.
    type UAData = { getHighEntropyValues: (h: string[]) => Promise<{ platformVersion?: string }> };
    const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
    uaData
      ?.getHighEntropyValues(["platformVersion"])
      .then(({ platformVersion }) => {
        if (Number(platformVersion?.split(".")[0]) < 13) return;
        return invoke<boolean>("enable_mica").then((ok) => ok && (root.dataset.vibrancy = ""));
      })
      .catch(() => {});
  }
}

/**
 * Zoom the page, like a browser's zoom: text, code and spacing all scale together. In the app the
 * webview zooms itself; in a plain browser (sample data) CSS zoom stands in.
 */
export function applyZoom(zoom: number) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (inTauri) getCurrentWebview().setZoom(z).catch(() => {});
  else document.documentElement.style.zoom = z === 1 ? "" : String(z);
}
