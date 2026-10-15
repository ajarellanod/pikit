/**
 * A conversation as the admin API serves it (`/admin/api/conversations/:id/…`), for the shared view
 * (`components/pikit/conversation.tsx`): its transcript, its live events, a message (with images, a web
 * search) and a stop. A view that only follows one live passes it to `useLive`.
 */

import type { ConversationSource } from "@/components/pikit/conversation";
import { api, type ApiPage, type ApiSendResponse, type ApiTranscriptEntry, follow, post } from "@/lib/api";
import { attachmentsOf } from "./composer";

export function adminSource(id: string): ConversationSource {
  const path = `/conversations/${encodeURIComponent(id)}`;
  return {
    id,
    transcript: ({ limit, cursor }) => api<ApiPage<ApiTranscriptEntry>>(`${path}/transcript?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`),
    follow: (onEvent, signal) => follow(`${path}/events`, onEvent, signal),
    send: ({ text, images, webSearch }) =>
      post<ApiSendResponse>(`${path}/messages`, {
        text,
        ...(images.length > 0 && { attachments: attachmentsOf(images) }),
        ...(webSearch && { webSearch: true }),
      }),
    abort: async () => {
      await post(`${path}/abort`);
    },
  };
}
