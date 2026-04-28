// Thin Front API client for the Search Front Conversations command.
// Reads `frontApiKey` from Raycast preferences. The bash flavour of these
// scripts (front-grab-context.sh, front-add-note.sh) reads from
// cx-briefing/.env instead — same value, different storage.

const FRONT_API_BASE = "https://api2.frontapp.com";

export type FrontStatus = "archived" | "unassigned" | "assigned" | "deleted" | string;

export type FrontConversation = {
  id: string;
  subject: string;
  status: FrontStatus;
  status_id?: string;
  recipient?: {
    handle?: string;
    role?: string;
    name?: string | null;
  } | null;
  assignee?: {
    email?: string;
    first_name?: string;
    last_name?: string;
  } | null;
  last_message?: {
    created_at?: number;
    is_inbound?: boolean;
  } | null;
  created_at?: number;
};

export type SearchResponse = {
  _results?: FrontConversation[];
  _pagination?: { next?: string | null };
  _error?: { status?: number; title?: string; message?: string };
};

export class FrontApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FrontApiError";
  }
}

export async function searchConversations(apiKey: string, query: string, limit = 20): Promise<FrontConversation[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${FRONT_API_BASE}/conversations/search/${encodeURIComponent(trimmed)}?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const json = (await res.json()) as SearchResponse;
  if (!res.ok || json._error) {
    const errMsg = json._error?.message || `HTTP ${res.status}`;
    throw new FrontApiError(errMsg, res.status);
  }
  return json._results ?? [];
}

// Deep link to open a conversation in the Front app/web client.
export function frontDeepLink(conversationId: string): string {
  return `https://app.frontapp.com/open/${conversationId}`;
}

// Format a unix-seconds timestamp as a relative-ish humanized string.
export function formatRelative(ts?: number | null): string {
  if (!ts) return "—";
  const ms = ts * 1000;
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y ago`;
}

export function statusAccessoryColor(status: FrontStatus): "green" | "yellow" | "secondaryText" | "red" {
  switch (status) {
    case "unassigned":
      return "red";
    case "assigned":
      return "yellow";
    case "archived":
      return "secondaryText";
    case "deleted":
      return "secondaryText";
    default:
      return "green";
  }
}
