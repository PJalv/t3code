import { SymbolView } from "../../components/ui/AppSymbol";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function PullRequestDiscussionStatus({ resolved }: { resolved: boolean }) {
  const gt = useGT();
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
        {resolved
          ? gt("Resolved", { $context: "review thread state" })
          : gt("Unresolved", { $context: "review thread state" })}
      </Text>
    </View>
  );
}
