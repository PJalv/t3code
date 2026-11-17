import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function PullRequestDiscussionStatus({ resolved }: { resolved: boolean }) {
  return (
    <View
      className={
        resolved
          ? "flex-row items-center gap-1 self-start"
          : "flex-row items-center gap-1 self-start rounded-md bg-warning px-2 py-1"
      }
    >
      <SymbolView
        name={resolved ? "checkmark.circle" : "text.bubble"}
        size={12}
        tintColorClassName={
          resolved ? "accent-adaptive-emerald-600-400" : "accent-warning-foreground"
        }
      />
      <Text
        className={
          resolved
            ? "text-xs font-t3-medium text-adaptive-emerald-600-400"
            : "text-xs font-t3-medium text-warning-foreground"
        }
      >
        {resolved ? "Resolved" : "Unresolved"}
      </Text>
    </View>
  );
}
