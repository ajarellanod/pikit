/**
 * A conversation live (`GET /chat/api/conversations/:id/events`), folded by `live-state.ts`: whether a
 * run goes, the answer as written, the tools running, and `changes` (read the messages again).
 *
 * The stream is open only while the person is here (`useActive`: the tab visible, touched in the last
 * minutes): on Cloudflare an open stream keeps the conversation's Durable Object awake. It reconnects
 * after it ends (an object evicted, a deploy), waiting longer after each failure, and when the person
 * comes back.
 */

import { type Dispatch, useEffect, useReducer } from "react";
import { useActive } from "./activity.ts";
import { follow } from "./client.ts";
import { ChatFailure } from "./errors.ts";
import { type Action, INITIAL, type LiveState, reduce } from "./live-state.ts";

export function useLive(chatId: string): LiveState & { paused: boolean; dispatch: Dispatch<Action> } {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const active = useActive();

  useEffect(() => dispatch({ type: "reset" }), [chatId]);

  useEffect(() => {
    if (!active) return;
    const stop = new AbortController();
    void (async () => {
      let wait = 1000;
      while (!stop.signal.aborted) {
        const started = Date.now();
        try {
          const following = follow(`/conversations/${encodeURIComponent(chatId)}/events`, (event) => dispatch({ type: "event", event }), stop.signal);
          dispatch({ type: "connected" });
          await following;
        } catch (error) {
          // Not this user's conversation, or no session: asking again changes nothing.
          if (error instanceof ChatFailure && (error.status === 401 || error.status === 404)) {
            dispatch({ type: "disconnected" });
            return;
          }
          // Else reconnect below.
        }
        if (stop.signal.aborted) return;
        dispatch({ type: "disconnected" });
        // A stream that lasted a while ended normally: back soon. One that failed at once: back off.
        wait = Date.now() - started > 30_000 ? 1000 : Math.min(wait * 2, 30_000);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })();
    return () => stop.abort();
  }, [chatId, active]);

  return { ...state, paused: !active, dispatch };
}
