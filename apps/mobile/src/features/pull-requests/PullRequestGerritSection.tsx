import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

import type { ReviewParsedDiff } from "../review/reviewModel";

export function filterGerritPatchSetFile(parsed: ReviewParsedDiff): ReviewParsedDiff {
  if (parsed.kind !== "files") return parsed;
  const files = parsed.files.filter((file) => file.path !== "/PATCHSET_LEVEL");
  if (files.length === parsed.files.length) return parsed;
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

export function gerritVoteOptions(values: readonly number[]) {
  return [...new Set(values)]
    .sort((a, b) => b - a)
    .map((value) => ({
      value: String(value),
      label: value > 0 ? `+${value}` : String(value),
    }));
}

export function gerritRequirementStatus(status: string | null) {
  switch (status) {
    case "satisfied":
      return "Satisfied";
    case "unsatisfied":
      return "Unsatisfied";
    case "not-applicable":
      return "Not applicable";
    case "override":
      return "Overridden";
    case "error":
      return "Error";
    default:
      return "Unavailable";
  }
}

export function PullRequestGerritSection({
  params,
  pr,
}: {
  readonly params: PullRequestParams;
  readonly pr: PullRequestDetail;
}) {
  const target = pullRequestTarget(params);
  const canWrite = useAtomValue(
    composerPullRequests.gerritCommand.permissionAtom(target.environmentId),
  );
  const command = useAtomCommand(composerPullRequests.gerritCommand, { reportFailure: false });
  const refresh = useAtomRefresh(composerPullRequests.detail(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [topic, setTopic] = useState("");
  const gerrit = pr.gerrit;
  if (!gerrit) return null;
  const run = async (input: Parameters<typeof command>[0]["input"]) => {
    if (busy) return false;
    setBusy(true);
    const result = await command({ ...target, input });
    setBusy(false);
    if (result._tag === "Failure") {
      setError("The provider could not complete this action.");
      return false;
    }
    setError(null);
    refresh();
    return true;
  };
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <Text className="font-t3-medium">Gerrit change</Text>
      <Text selectable className="font-mono text-xs">
        {gerrit.changeId} · Patch set {gerrit.currentPatchSet}
      </Text>
      <Text>Topic: {gerrit.topic ?? "None"}</Text>
      {canWrite && gerrit.permissions?.setTopic ? (
        editing ? (
          <View className="gap-2">
            <TextInput
              accessibilityLabel="Topic"
              value={topic}
              onChangeText={setTopic}
              editable={!busy}
            />
            <Button
              label="Save topic"
              disabled={busy}
              onPress={() =>
                void run({
                  ...target.input,
                  command: "setTopic",
                  payload: { topic: topic.trim() || null },
                }).then((ok) => {
                  if (ok) setEditing(false);
                })
              }
            />
            <Button label="Cancel" disabled={busy} onPress={() => setEditing(false)} />
          </View>
        ) : (
          <Button
            label="Edit topic"
            disabled={busy}
            onPress={() => {
              setTopic(gerrit.topic ?? "");
              setEditing(true);
            }}
          />
        )
      ) : null}
      <Text>
        {gerrit.isPrivate ? "Private" : "Public"} · {gerrit.isWip ? "Work in progress" : "Ready"}
      </Text>
      {canWrite && gerrit.permissions?.setPrivate ? (
        <Button
          label={gerrit.isPrivate ? "Make public" : "Make private"}
          disabled={busy}
          onPress={() =>
            void run({
              ...target.input,
              command: "setPrivate",
              payload: { isPrivate: !gerrit.isPrivate },
            })
          }
        />
      ) : null}
      <Text className="font-t3-medium">Votes</Text>
      {gerrit.labels.length === 0 ? (
        <Text>No labels reported.</Text>
      ) : (
        gerrit.labels.map((label) => {
          const options = gerritVoteOptions(label.permittedValues);
          return (
            <View key={label.name} className="gap-1">
              <Text className="font-t3-medium">{label.name}</Text>
              {label.votes.length === 0 ? (
                <Text>No votes yet</Text>
              ) : (
                label.votes.map((vote, index) => (
                  <Text key={vote.account._account_id ?? index}>
                    {vote.account.name ??
                      vote.account.display_name ??
                      vote.account.username ??
                      vote.account.email ??
                      "Unknown account"}
                    : {vote.value > 0 ? "+" : ""}
                    {vote.value}
                  </Text>
                ))
              )}
              {canWrite && options.length > 0 ? (
                <Menu
                  title={`Vote on ${label.name}`}
                  actions={options.map((option) => ({ id: option.value, title: option.label }))}
                  onPressAction={({ nativeEvent }) => {
                    const value = options.find((option) => option.value === nativeEvent.event);
                    if (value)
                      void run({
                        ...target.input,
                        command: "setVotes",
                        payload: { votes: { [label.name]: Number(value.value) } },
                      });
                  }}
                >
                  <View pointerEvents="none">
                    <Button label={`Vote on ${label.name}`} disabled={busy} onPress={() => {}} />
                  </View>
                </Menu>
              ) : null}
            </View>
          );
        })
      )}
      <Text className="font-t3-medium">Submit requirements</Text>
      <Text>
        Submittable:{" "}
        {gerrit.submittable === null ? "Unavailable" : gerrit.submittable ? "Yes" : "No"}
      </Text>
      {gerrit.submitRequirements.length === 0 ? (
        <Text>No requirements reported.</Text>
      ) : (
        gerrit.submitRequirements.map((requirement) => (
          <Text key={requirement.name}>
            {requirement.name}: {gerritRequirementStatus(requirement.status)}
            {requirement.description ? `: ${requirement.description}` : ""}
          </Text>
        ))
      )}
      {error ? <Text className="text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
