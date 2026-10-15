/**
 * The Settings dialog, opened from the sidebar's foot: a large modal with a search box and the
 * sections, grouped, on the left, and the chosen section's rows on the right. The first section is the
 * dashboard's own, General (its theme, its sounds: this browser's, `localStorage`, nothing of the
 * service's); then one per installed component that brings one (`src/settings/<component>/`,
 * `lib/settings.ts`), shown when the App provides what it requires. A change applies to the next run.
 * A section may open another (`useOpenSettingsSection`); the shell opens one by its id (`section`: the
 * page's `?settings=<id>`). Its frame, navigation and rows are the shared `settings-shell` and
 * `settings-rows`.
 */

import { Computer, HalfMoon, Settings, SunLight } from "iconoir-react";
import { Dialog } from "radix-ui";
import { useMemo } from "react";
import { Switch } from "@/components/bui/Switch";
import { Segmented, SettingsHeading, SettingsRow } from "@/components/pikit/settings-rows";
import { SETTINGS_FRAME_STYLE, type SettingsEntry, SettingsPanels, settingsFrameClass, useSettingsChoice } from "@/components/pikit/settings-shell";
import type { ApiApp } from "@/lib/api";
import { groupOf, type SettingsSectionDefinition, SettingsNavigation, visibleSettings } from "@/lib/settings";
import { setSounds, useSounds } from "@/lib/sounds";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

function GeneralSettings() {
  const theme = useTheme();
  const sounds = useSounds();
  return (
    <div>
      <SettingsHeading>Appearance</SettingsHeading>
      <SettingsRow label="Theme" description="Light, dark, or as the system is. This browser's only.">
        <Segmented<Theme>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "The system's theme", icon: Computer },
            { value: "light", label: "Light mode", icon: SunLight },
            { value: "dark", label: "Dark mode", icon: HalfMoon },
          ]}
        />
      </SettingsRow>
      <SettingsRow label="Interaction sounds" description="A quiet cue on each click.">
        <Switch checked={sounds} label="Interaction sounds" onChange={setSounds} />
      </SettingsRow>
    </div>
  );
}

/** The dashboard's own section: first, kept in this browser. */
const GENERAL: SettingsSectionDefinition = { id: "general", title: "General", icon: Settings, group: "Dashboard", order: 0, keywords: ["theme", "dark", "light", "sounds", "appearance"], component: GeneralSettings };

/** A section as the shared navigation lists it: its group by `groupOf`. */
const entryOf = (section: SettingsSectionDefinition): SettingsSectionDefinition & SettingsEntry => ({ ...section, group: groupOf(section) });

export function SettingsDialog({ app, open, onOpenChange, section }: { app: ApiApp; open: boolean; onOpenChange: (open: boolean) => void; section?: string }) {
  const all = useMemo(() => [GENERAL, ...visibleSettings(app)].map(entryOf), [app]);
  const choice = useSettingsChoice(all, open, section);
  const Section = choice.current?.component;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px]" style={{ animation: "fade-in 150ms ease-out both" }} />
        <Dialog.Content aria-describedby={undefined} className={settingsFrameClass()} style={SETTINGS_FRAME_STYLE}>
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <SettingsPanels choice={choice} onClose={() => onOpenChange(false)}>
            {/* A section's link to another: shown whatever the search. */}
            {choice.current !== undefined && Section !== undefined && (
              <SettingsNavigation.Provider value={choice.open}>
                <Section key={choice.current.id} />
              </SettingsNavigation.Provider>
            )}
          </SettingsPanels>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
