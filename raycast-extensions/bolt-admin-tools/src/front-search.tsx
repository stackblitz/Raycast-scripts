import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
  FrontApiError,
  FrontConversation,
  formatRelative,
  frontDeepLink,
  searchConversations,
  statusAccessoryColor,
} from "./lib/front";

type Preferences = {
  frontApiKey?: string;
};

const DEBOUNCE_MS = 300;

export default function Command() {
  const { frontApiKey } = getPreferenceValues<Preferences>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FrontConversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Missing key screen — easier than failing each search silently.
  if (!frontApiKey) {
    return (
      <Detail
        markdown={`# Front API Key Missing\n\nThis command needs a Front API token to search conversations.\n\n1. Open **Bolt Admin Tools → Preferences** in Raycast.\n2. Paste the value of \`FRONT_API_KEY\` from \`cx-briefing/.env\`.\n3. Re-run the command.`}
        actions={
          <ActionPanel>
            <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel>
        }
      />
    );
  }

  // Debounced search whenever query changes.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const found = await searchConversations(frontApiKey, trimmed);
        setResults(found);
      } catch (err) {
        const msg = err instanceof FrontApiError ? err.message : err instanceof Error ? err.message : String(err);
        setResults([]);
        setError(msg);
        await showToast({ style: Toast.Style.Failure, title: "Front search failed", message: msg });
      } finally {
        setIsLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, frontApiKey]);

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search Front by subject, body, customer email…"
      throttle
    >
      {error ? (
        <List.EmptyView icon={Icon.Warning} title="Search failed" description={error} />
      ) : results.length === 0 && query.trim() ? (
        <List.EmptyView icon={Icon.MagnifyingGlass} title="No conversations match" description={query} />
      ) : results.length === 0 ? (
        <List.EmptyView icon={Icon.MagnifyingGlass} title="Type to search Front" />
      ) : (
        results.map((conv) => <ConversationItem key={conv.id} conversation={conv} />)
      )}
    </List>
  );
}

function ConversationItem({ conversation }: { conversation: FrontConversation }) {
  const subject = conversation.subject?.trim() || "(no subject)";
  const handle = conversation.recipient?.handle ?? "—";
  const lastTs = conversation.last_message?.created_at;
  const link = frontDeepLink(conversation.id);
  const colorName = statusAccessoryColor(conversation.status);
  const color =
    colorName === "green"
      ? Color.Green
      : colorName === "yellow"
        ? Color.Yellow
        : colorName === "red"
          ? Color.Red
          : Color.SecondaryText;

  return (
    <List.Item
      title={subject}
      subtitle={handle}
      icon={{ source: Icon.Envelope, tintColor: color }}
      accessories={[{ text: conversation.status }, { text: formatRelative(lastTs) }]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open in Front" url={link} />
          <Action.CopyToClipboard title="Copy Conversation URL" content={link} />
          <Action.CopyToClipboard
            title="Copy Conversation ID"
            content={conversation.id}
            shortcut={{ modifiers: ["cmd"], key: "i" }}
          />
          {handle !== "—" && (
            <Action.CopyToClipboard
              title="Copy Customer Handle"
              content={handle}
              shortcut={{ modifiers: ["cmd"], key: "h" }}
            />
          )}
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}
