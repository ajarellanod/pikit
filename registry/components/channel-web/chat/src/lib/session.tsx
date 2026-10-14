/**
 * The signed-in user and what the page knows before anyone signs in (`ChatConfig`), for every screen.
 */

import { createContext, useContext, useEffect } from "react";
import type { ChatConfig, ChatMe } from "./chat-api.ts";

export interface ChatSession {
  config: ChatConfig;
  me: ChatMe;
  /** Reads the user again (a name changed, a provider linked). */
  reloadMe(): Promise<void>;
  /** Signs out of this browser, then shows the sign-in. */
  signOut(): Promise<void>;
  /** After every session was ended elsewhere: shows the sign-in. */
  signedOut(): void;
}

export const SessionContext = createContext<ChatSession | undefined>(undefined);

export function useSession(): ChatSession {
  const value = useContext(SessionContext);
  if (value === undefined) throw new Error("useSession outside a signed-in page");
  return value;
}

/** The tab's title: `<what> · <the assistant's name>`, or the name alone. */
export function usePageTitle(name: string, what?: string): void {
  useEffect(() => {
    document.title = what === undefined || what === "" ? name : `${what} · ${name}`;
  }, [name, what]);
}

/** A provider's shown name, from the methods `config` lists; its id when it lists none. */
export function providerName(config: ChatConfig, id: string): string {
  if (id === "password" || id === "credential") return "Password";
  const method = config.methods.find((each) => (each.kind === "social" || each.kind === "oidc") && each.id === id);
  return method !== undefined && "name" in method ? method.name : id;
}

/** The providers `config` offers (built-in and OIDC alike). */
export function providersOf(config: ChatConfig): { id: string; name: string }[] {
  return config.methods.flatMap((each) => (each.kind === "social" || each.kind === "oidc" ? [{ id: each.id, name: each.name }] : []));
}

export const offers = (config: ChatConfig, kind: "password" | "magic-link"): boolean => config.methods.some((each) => each.kind === kind);
