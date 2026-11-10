/**
 * The Settings dialog, opened from the sidebar's foot: a large modal with a search box and the
 * sections, grouped, on the left, and the chosen section's rows on the right. The first sections are the
 * dashboard's own: General (its theme, its sounds: this browser's, `localStorage`, nothing of the
 * service's) and App (what the App is made of, read only: `app-settings.tsx`); then one per installed
 * component that brings one (`src/settings/<component>/`,
 * `lib/settings.ts`), shown when the App provides what it requires. A change applies to the next run.
 * Sections of one `entry` are one entry of the navigation, their parts one after another, each its own
 * component's (`settings-entries.ts`). A section may open another (`useOpenSettingsSection`); the shell
 * opens one by its id (`section`: the page's `?settings=<id>`): a part's id opens the entry holding it. Its frame, navigation and rows are the shared `settings-shell` and
 * `settings-rows`. A part may open a page of its own in place of the entry (`useSettingsPage`: an
 * agent's, from the Agents list): the other parts hidden, the section's title too; its back button or
 * Escape (outside a text field) closes it, never the dialog.
 */

import { Computer, Cube, HalfMoon, Settings, SunLight } from "iconoir-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { Switch } from "@/components/bui/Switch";
import { AppSettings } from "@/components/pikit/app-settings";
import { Segmented, SettingsHeading, SettingsRow } from "@/components/pikit/settings-rows";
import { SETTINGS_FRAME_STYLE, type SettingsEntry, SettingsPanels, settingsFrameClass, useSettingsChoice } from "@/components/pikit/settings-shell";
import type { ApiApp } from "@/lib/api";
import { type SettingsPage, SettingsPageContext, type SettingsSectionDefinition, SettingsNavigation, visibleEntries } from "@/lib/settings";
import { entryIdOf } from "@/lib/settings-entries";
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

/** The dashboard's own sections: first General, kept in this browser; then App, what the App is made of. */
const GENERAL: SettingsSectionDefinition = { id: "general", title: "General", icon: Settings, group: "Dashboard", order: 0, keywords: ["theme", "dark", "light", "sounds", "appearance"], component: GeneralSettings };
const APP: SettingsSectionDefinition = {
  id: "app",
  title: "App",
  icon: Cube,
  group: "Dashboard",
  order: 1,
  keywords: ["composition", "components", "agents", "tools", "capabilities", "wiring", "pipelines", "routes", "config", "cloudflare", "server"],
  component: AppSettings,
};

/** An entry as the shared navigation lists it: the first part's icon, every part to show. */
type DialogEntry = SettingsEntry & { parts: readonly SettingsSectionDefinition[] };
const own = (section: SettingsSectionDefinition): DialogEntry => ({ id: section.id, title: section.title, group: section.group ?? "Dashboard", icon: section.icon, keywords: section.keywords ?? [], parts: [section] });

/** A part's page, of the entry it was opened in. */
type OpenPage = { entry: string; part: string; page: string };

/** Whether a key pressed in `target` is the field's (a text being typed, a select): Escape there is not "back". */
const inField = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function SettingsDialog({ app, open, onOpenChange, section }: { app: ApiApp; open: boolean; onOpenChange: (open: boolean) => void; section?: string }) {
  const entries = useMemo(() => visibleEntries(app), [app]);
  const all = useMemo<DialogEntry[]>(() => [own(GENERAL), own(APP), ...entries.map((entry) => ({ ...entry, icon: entry.parts[0]?.icon }))], [entries]);
  const choice = useSettingsChoice(all, open, section === undefined ? undefined : entryIdOf(entries, section));
  const current = choice.current;
  const [opened, setOpened] = useState<OpenPage>();
  const [closed, setClosed] = useState<OpenPage>();
  // an entry chosen (the navigation's, the current one too: back to its list; a section's link): no page,
  // and what closed last gives no focus back when its list shows again
  const leavePage = () => {
    setOpened(undefined);
    setClosed(undefined);
  };
  const openPart = (id: string) => {
    leavePage();
    choice.open(entryIdOf(entries, id));
  };
  // a page belongs to the entry it was opened in, while the dialog stays open
  const page = opened !== undefined && opened.entry === current?.id ? opened : undefined;
  useEffect(() => {
    if (!open) leavePage();
  }, [open]);
  const closePage = () => {
    setClosed(page);
    setOpened(undefined);
  };
  const pageOf = (part: string): SettingsPage => ({
    page: page?.part === part ? page.page : undefined,
    closed: page === undefined && closed?.part === part && closed.entry === current?.id ? closed.page : undefined,
    open: (each) => {
      if (current === undefined) return;
      setClosed(undefined);
      setOpened({ entry: current.id, part, page: each });
    },
    close: closePage,
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px]" style={{ animation: "fade-in 150ms ease-out both" }} />
        <Dialog.Content
          aria-describedby={undefined}
          className={settingsFrameClass()}
          style={SETTINGS_FRAME_STYLE}
          onEscapeKeyDown={(event) => {
            if (page === undefined) return;
            // a page open: Escape goes back to the entry (outside a text field), never closes the dialog
            event.preventDefault();
            if (!inField(event.target)) closePage();
          }}
        >
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <SettingsPanels choice={choice} onChoose={leavePage} onClose={() => onOpenChange(false)} titled={page === undefined}>
            {/* A section's link to another: shown whatever the search. */}
            {current !== undefined && (
              <SettingsNavigation.Provider value={openPart}>
                <div key={current.id}>
                  {/* the other parts stay mounted while one shows a page: hidden, they keep what they hold */}
                  {current.parts.map(({ id, component: Part }) => (
                    <section key={id} data-settings-part={id} hidden={page !== undefined && page.part !== id}>
                      <SettingsPageContext.Provider value={pageOf(id)}>
                        <Part />
                      </SettingsPageContext.Provider>
                    </section>
                  ))}
                </div>
              </SettingsNavigation.Provider>
            )}
          </SettingsPanels>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
