import { T, useGT, msg, useMessages } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";
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

export function gerritRequirementStatus(status: string | null, resolve: MessageResolver = m) {
  switch (status) {
    case "satisfied":
      return resolve(msg("Satisfied", { $context: "Gerrit submit requirement status" }));
    case "unsatisfied":
      return resolve(msg("Unsatisfied", { $context: "Gerrit submit requirement status" }));
    case "not-applicable":
      return resolve(msg("Not applicable", { $context: "Gerrit submit requirement status" }));
    case "override":
      return resolve(msg("Overridden", { $context: "Gerrit submit requirement status" }));
    case "error":
      return resolve(msg("Error", { $context: "Gerrit submit requirement status" }));
    default:
      return resolve(msg("Unavailable", { $context: "Gerrit submit requirement status" }));
  }
}

export function PullRequestGerritSection({
  params,
  pr,
}: {
  readonly params: PullRequestParams;
  readonly pr: PullRequestDetail;
}) {
  const gt = useGT();
  const resolve = useMessages();
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
      setError(gt("The provider could not complete this action."));
      return false;
    }
    setError(null);
    refresh();
    return true;
  };
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <Text className="font-t3-medium">
        <T>Gerrit change</T>
      </Text>
      <Text selectable className="font-mono text-xs">
        {gt("{changeId} · Patch set {number}", {
          changeId: gerrit.changeId,
          number: gerrit.currentPatchSet,
        })}
      </Text>
      <Text>
        {gerrit.topic ? gt("Topic: {topic}", { topic: gerrit.topic }) : gt("Topic: None")}
      </Text>
      {canWrite && gerrit.permissions?.setTopic ? (
        editing ? (
          <View className="gap-2">
            <TextInput
              accessibilityLabel={gt("Topic", { $context: "Gerrit topic, noun" })}
              value={topic}
              onChangeText={setTopic}
              editable={!busy}
            />
            <Button
              label={gt("Save topic")}
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
            <Button label={gt("Cancel")} disabled={busy} onPress={() => setEditing(false)} />
          </View>
        ) : (
          <Button
            label={gt("Edit topic")}
            disabled={busy}
            onPress={() => {
              setTopic(gerrit.topic ?? "");
              setEditing(true);
            }}
          />
        )
      ) : null}
      <Text>
        {gerrit.isPrivate
          ? gt("Private", { $context: "Gerrit change visibility" })
          : gt("Public", { $context: "Gerrit change visibility" })}{" "}
        ·{" "}
        {gerrit.isWip
          ? gt("Work in progress")
          : gt("Ready", { $context: "Gerrit change ready for review" })}
      </Text>
      {canWrite && gerrit.permissions?.setPrivate ? (
        <Button
          label={gerrit.isPrivate ? gt("Make public") : gt("Make private")}
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
      <Text className="font-t3-medium">
        <T>Votes</T>
      </Text>
      {gerrit.labels.length === 0 ? (
        <Text>
          <T>No labels reported.</T>
        </Text>
      ) : (
        gerrit.labels.map((label) => {
          const options = gerritVoteOptions(label.permittedValues, label.valueDescriptions);
          return (
            <View key={label.name} className="gap-1">
              <Text className="font-t3-medium">{label.name}</Text>
              {label.votes.length === 0 ? (
                <Text>
                  <T>No votes yet</T>
                </Text>
              ) : (
                label.votes.map((vote, index) => (
                  <Text key={vote.account._account_id ?? index}>
                    {vote.account.name ??
                      vote.account.display_name ??
                      vote.account.username ??
                      vote.account.email ??
                      gt("Unknown account")}
                    : {vote.value > 0 ? "+" : ""}
                    {vote.value}
                  </Text>
                ))
              )}
              {canWrite && options.length > 0 ? (
                <Menu
                  title={gt("Vote on {label}", { label: label.name })}
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
                    <Button
                      label={gt("Vote on {label}", { label: label.name })}
                      disabled={busy}
                      onPress={() => {}}
                    />
                  </View>
                </Menu>
              ) : null}
            </View>
          );
        })
      )}
      <Text className="font-t3-medium">
        <T>Submit requirements</T>
      </Text>
      <Text>
        {gerrit.submittable === null
          ? gt("Submit readiness unavailable")
          : gerrit.submittable
            ? gt("Ready to submit")
            : gt("Not ready to submit")}
      </Text>
      {gerrit.submitRequirements.length === 0 ? (
        <Text>
          <T>No requirements reported.</T>
        </Text>
      ) : (
        gerrit.submitRequirements.map((requirement) => (
          <Text key={requirement.name}>
            {requirement.name}: {gerritRequirementStatus(requirement.status, resolve)}
            {requirement.description ? `: ${requirement.description}` : ""}
          </Text>
        ))
      )}
      {error ? <Text className="text-danger-foreground">{error}</Text> : null}
    </View>
  );
}
