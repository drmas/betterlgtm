import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Suspense, useEffect, useState } from "react";
import { Settings } from "../lazy";
import { applyZoom } from "../platform";
import { useSettings } from "../settings";
import { EV, initialSection, type SettingsData } from "../settingsWindow";
import type { SettingsSection } from "./Settings";

/** The macOS Settings window (see settingsWindow.ts). */
export function SettingsWindow() {
  const [settings, update] = useSettings();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [data, setData] = useState<SettingsData>({ orgs: null, orgsError: null, requests: null });

  useEffect(() => {
    const un = [listen<SettingsData>(EV.data, (e) => setData(e.payload)), listen<SettingsSection>(EV.section, (e) => setSection(e.payload))];
    emitTo("main", EV.ready);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea")) && getCurrentWindow().close();
    window.addEventListener("keydown", esc);
    return () => {
      un.forEach((p) => p.then((f) => f()));
      window.removeEventListener("keydown", esc);
    };
  }, []);

  useEffect(() => {
    if (settings.theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => applyZoom(settings.zoom), [settings.zoom]);

  return (
    <div className="app">
      <Suspense fallback={null}>
        <Settings
          settings={settings}
          update={update}
          section={section}
          onSection={setSection}
          orgs={data.orgs}
          orgsError={data.orgsError}
          requests={data.requests}
          onReloadOrgs={() => emitTo("main", EV.reloadOrgs)}
          onClearData={() => emitTo("main", EV.clearData)}
        />
      </Suspense>
    </div>
  );
}
