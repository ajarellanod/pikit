/**
 * What the shell (`app.tsx`) gives the pages: the App's composition, its agents, the views it shows,
 * the operator, a new chat (`newChat`), and two places a page can fill: the tab bar's right end
 * (`TabActions`: a conversation's Context button and its menu) and the side panel next to the main pane
 * (`SidePanel`: a conversation's Context).
 */

import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import type { ApiAgent, ApiApp } from "./api.ts";
import type { View } from "./views.ts";

export interface ShellState {
  app: ApiApp;
  /** The App's agents (`GET /admin/api/agents`), by name; undefined until read. */
  agents?: ApiAgent[];
  /** Opens a new chat (the home, its draft empty), with `agent` chosen when given. */
  newChat(agent?: string): void;
  /** The views the App's composition allows, in sidebar order. */
  views: View[];
  /** The signed-in operator's id, when this browser signed in (`ApiSession.operator`). */
  operator?: string;
  /** Where the tab bar's right end and the side panel are, once mounted. */
  slots: { actions: HTMLElement | null; side: HTMLElement | null };
}

export const ShellContext = createContext<ShellState | undefined>(undefined);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (shell === undefined) throw new Error("useShell: outside the dashboard's shell");
  return shell;
}

/** Shown at the tab bar's right end while the page is. */
export function TabActions({ children }: { children: ReactNode }) {
  const target = useContext(ShellContext)?.slots.actions;
  return target === null || target === undefined ? null : createPortal(children, target);
}

/** A panel of its own next to the main pane (wide screens), while the page is. */
export function SidePanel({ children }: { children: ReactNode }) {
  const target = useContext(ShellContext)?.slots.side;
  return target === null || target === undefined ? null : createPortal(children, target);
}

/** The App's name: `ApiApp` has none yet, so "pikit" unless one is there. */
export function appName(app: ApiApp): string {
  const name = (app as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name : "pikit";
}
