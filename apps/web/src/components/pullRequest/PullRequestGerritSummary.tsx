import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestGerritDetail,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  MinusCircleIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";

export function gerritVoteOptions(
  values: readonly number[],
  descriptions: Readonly<Record<string, string>> = {},
) {
  return [...new Set(values)]
    .sort((a, b) => b - a)
    .map((value) => {
      const score = value > 0 ? `+${value}` : String(value);
      const description = descriptions[score] ?? descriptions[String(value)];
      return { value: String(value), label: description ? `${score} ${description}` : score };
    });
}

export function gerritRequirementStatus(status: string | null) {
  switch (status) {
    case "satisfied":
      return "Satisfied";
    case "unsatisfied":
      return "Not met";
    case "not-applicable":
      return "Not applicable";
    case "override":
      return "Overridden";
    case "error":
      return "Error";
    case "unknown":
      return "Unknown";
    default:
      return "Unavailable";
  }
}

export function gerritRequirementTone(status: string | null) {
  switch (status) {
    case "satisfied":
      return "success" as const;
    case "override":
      return "info" as const;
    case "unsatisfied":
      return "warning" as const;
    case "error":
      return "error" as const;
    default:
      return "secondary" as const;
  }
}

export { gerritCommitMessageParts } from "@t3tools/client-runtime/pull-request-editing";

export function gerritSummaryControls(
  canWrite: boolean,
  permissions: PullRequestGerritDetail["permissions"],
) {
  return {
    topic: canWrite && permissions?.setTopic === true,
    private: canWrite && permissions?.setPrivate === true,
  };
}

export function gerritTopicValue(value: string): string | null {
  return value.trim() || null;
}

export function GerritVotePicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: PullRequestGerritDetail["labels"][number];
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const options = gerritVoteOptions(label.permittedValues, label.valueDescriptions);
  if (options.length === 0) return null;
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="xs" aria-label={`Vote on ${label.name}`}>
        <span>{options.find((option) => option.value === value)?.label ?? "Vote"}</span>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function gerritAccountName(
  account: PullRequestGerritDetail["labels"][number]["votes"][number]["account"],
) {
  return (
    account.name ?? account.display_name ?? account.username ?? account.email ?? "Unknown account"
  );
}

function RequirementIcon({ status }: { status: string | null }) {
  switch (gerritRequirementTone(status)) {
    case "success":
      return <CheckCircle2Icon aria-hidden className="size-3.5 shrink-0 text-success" />;
    case "info":
      return <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0 text-info" />;
    case "warning":
      return <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />;
    case "error":
      return <XCircleIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />;
    default:
      return <MinusCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function GerritRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-6 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</span>
    </div>
  );
}

function GerritHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function PullRequestGerritSummary({
  environmentId,
  reference,
  detail,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  onRefresh: () => void;
}) {
  const canWrite = useAtomValue(pullRequestEnvironment.gerritCommand.permissionAtom(environmentId));
  const command = useAtomCommand(pullRequestEnvironment.gerritCommand, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topic, setTopic] = useState("");
  const gerrit = detail.gerrit;
  if (!gerrit) return null;
  const controls = gerritSummaryControls(canWrite, gerrit.permissions);
  // Gerrit keeps the flag after a change closes, but it only means something while it is open.
  const wip = gerrit.isWip && detail.state === "open";
  const run = async (
    input: Parameters<typeof command>[0]["input"],
    failure: string,
    onSuccess?: () => void,
  ) => {
    setPending(true);
    const result = await command({ environmentId, input });
    setPending(false);
    if (result._tag === "Failure") toastManager.add({ type: "error", title: failure });
    else {
      onSuccess?.();
      onRefresh();
    }
  };
  const saveTopic = () =>
    run(
      { ...reference, command: "setTopic", payload: { topic: gerritTopicValue(topic) } },
      "Could not set topic",
      () => setEditingTopic(false),
    );
  const togglePrivate = () =>
    run(
      { ...reference, command: "setPrivate", payload: { isPrivate: !gerrit.isPrivate } },
      "Could not change privacy",
    );
  const vote = (name: string, value: string) =>
    run(
      { ...reference, command: "setVotes", payload: { votes: { [name]: Number(value) } } },
      "Could not set vote",
    );

  const review = (
    <>
      <div className="space-y-2">
        <GerritHeading title="Submit requirements">
          {gerrit.submittable === null ? null : gerrit.submittable ? (
            <Badge size="sm" variant="success">
              Ready to submit
            </Badge>
          ) : (
            <Badge size="sm" variant="warning">
              Not ready to submit
            </Badge>
          )}
        </GerritHeading>
        {gerrit.submitRequirements.length === 0 ? (
          <p className="text-muted-foreground">No requirements reported.</p>
        ) : (
          <ul className="space-y-1.5">
            {gerrit.submitRequirements.map((requirement) => (
              <li key={requirement.name} className="space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <RequirementIcon status={requirement.status} />
                  <span className="min-w-0 break-words">{requirement.name}</span>
                  <Badge size="sm" variant={gerritRequirementTone(requirement.status)}>
                    {gerritRequirementStatus(requirement.status)}
                  </Badge>
                </div>
                {requirement.description && requirement.status !== "satisfied" ? (
                  <p className="pl-5.5 text-muted-foreground">{requirement.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <GerritHeading title="Votes" />
        {gerrit.labels.length === 0 ? (
          <p className="text-muted-foreground">No labels reported.</p>
        ) : (
          <ul className="space-y-2">
            {gerrit.labels.map((label) => {
              const votes = label.votes.filter((entry) => entry.value !== 0);
              return (
                <li key={label.name} className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <span className="font-medium">{label.name}</span>
                    {votes.length === 0 ? (
                      <p className="text-muted-foreground">No votes yet</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {votes.map((entry, index) => (
                          <Badge
                            key={entry.account._account_id ?? index}
                            size="sm"
                            variant={entry.value > 0 ? "success" : "error"}
                          >
                            {entry.value > 0 ? `+${entry.value}` : entry.value}{" "}
                            {gerritAccountName(entry.account)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="w-36 shrink-0">
                    <GerritVotePicker
                      label={label}
                      value={null}
                      disabled={!canWrite || pending}
                      onChange={(value) => void vote(label.name, value)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );

  return (
    <section aria-label="Gerrit change" className="space-y-4 px-4 py-3 text-xs">
      {wip ? (
        <Alert variant="warning">
          <CircleDashedIcon />
          <AlertTitle>Work in progress</AlertTitle>
          <AlertDescription>
            Reviewers are not notified and the change cannot be submitted until it is ready for
            review.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1">
        <GerritRow label="Change">
          <span className="truncate font-mono text-muted-foreground">{gerrit.changeId}</span>
          <Badge size="sm" variant="outline">
            Patch set {gerrit.currentPatchSet}
          </Badge>
        </GerritRow>
        <GerritRow label="Topic">
          {editingTopic && controls.topic ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTopic();
              }}
            >
              <Input
                aria-label="Topic"
                size="sm"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                disabled={pending}
              />
              <Button size="xs" type="submit" disabled={pending}>
                Save
              </Button>
              <Button
                size="xs"
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditingTopic(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <>
              {gerrit.topic ? (
                <Badge size="sm" variant="secondary">
                  {gerrit.topic}
                </Badge>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
              {controls.topic ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setTopic(gerrit.topic ?? "");
                    setEditingTopic(true);
                  }}
                >
                  Edit
                </Button>
              ) : null}
            </>
          )}
        </GerritRow>
        <GerritRow label="Visibility">
          <Badge size="sm" variant={gerrit.isPrivate ? "warning" : "outline"}>
            {gerrit.isPrivate ? "Private" : "Public"}
          </Badge>
          {controls.private ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void togglePrivate()}
            >
              {gerrit.isPrivate ? "Make public" : "Make private"}
            </Button>
          ) : null}
        </GerritRow>
      </div>
      {wip ? (
        <details className="group space-y-3">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            Votes and submit requirements
          </summary>
          <div className="space-y-4 pt-3">{review}</div>
        </details>
      ) : (
        review
      )}
    </section>
  );
}
