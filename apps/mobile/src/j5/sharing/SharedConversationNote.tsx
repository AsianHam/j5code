import { isSharedNote } from "@t3tools/client-runtime/j5/shared-conversation";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * The note the platform gave the agent with the next message, as one muted line that opens to its
 * words. Its words are the server's, and nothing here reads them.
 */
export function SharedConversationNote(props: {
  readonly message: object & { readonly text: string };
  readonly timestampLabel: string;
}) {
  const [open, setOpen] = useState(false);
  if (!isSharedNote(props.message)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      className="mb-5 items-start px-1"
      onPress={() => setOpen((value) => !value)}
    >
      <Text className="text-xs text-foreground-muted">
        The agent was given a note with the next message
        {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
      </Text>
      {open ? (
        <View className="mt-1.5 border-l border-border pl-3">
          <Text selectable className="text-xs text-foreground-muted">
            {props.message.text}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
