import { useGT } from "gt-react";
import { CircleCheckIcon, MessageCircleIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export function PullRequestDiscussionStatus({ resolved }: { resolved: boolean }) {
  const gt = useGT();
  if (resolved) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success-foreground">
        <CircleCheckIcon aria-hidden className="size-3" />
        {gt("Resolved", { $context: "review thread state" })}
      </span>
    );
  }
  return (
    <Badge variant="warning" size="sm">
      <MessageCircleIcon aria-hidden />
      {gt("Unresolved", { $context: "review thread state" })}
    </Badge>
  );
}
