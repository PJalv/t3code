import { CircleCheckIcon, MessageCircleIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export function PullRequestDiscussionStatus({ resolved }: { resolved: boolean }) {
  if (resolved) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success-foreground">
        <CircleCheckIcon aria-hidden className="size-3" />
        Resolved
      </span>
    );
  }
  return (
    <Badge variant="warning" size="sm">
      <MessageCircleIcon aria-hidden />
      Unresolved
    </Badge>
  );
}
