import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";

export interface AgentLibraryNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
}

export function AgentLibraryToast(props: {
  notification: AgentLibraryNotification;
  onDismiss: () => void;
}) {
  const { notification, onDismiss } = props;
  const insets = useSafeAreaInsets();
  // oxlint-disable-next-line t3code/react-effect-budget -- dismisses the toast after a delay, a timer owned by its lifetime.
  useEffect(() => {
    const timer = setTimeout(onDismiss, notification.type === "error" ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [notification, onDismiss]);
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-5"
      style={{ bottom: Math.max(insets.bottom, 16) }}
    >
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="flex-row items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg"
      >
        <View className="flex-1 gap-1">
          <Text
            className={
              notification.type === "error"
                ? "font-t3-semibold text-danger-foreground"
                : "font-t3-semibold text-foreground"
            }
          >
            {notification.title}
          </Text>
          {notification.description ? (
            <Text className="text-sm text-foreground-muted">{notification.description}</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          hitSlop={8}
          className="px-2 py-1"
          onPress={onDismiss}
        >
          <Text>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
