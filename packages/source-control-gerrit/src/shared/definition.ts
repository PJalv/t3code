import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  projectChangeRequestHost,
  parseChangeRequestPath,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/shared/definition";

const KIND = SourceControlProviderKind.make("gerrit");

/**
 * Gerrit can be served below a path prefix, and HTTP clone URLs add `/a/` for authenticated
 * access, so the web root is the remote URL minus `/a/` and the project path.
 */
function webRoot(host: string, repository: string, remoteUrl: string | undefined): string {
  const remote = URL.parse(remoteUrl ?? "");
  if (
    remote === null ||
    (remote.protocol !== "http:" && remote.protocol !== "https:") ||
    (remote.hostname.toLowerCase() !== host.toLowerCase() &&
      remote.host.toLowerCase() !== host.toLowerCase())
  )
    return `https://${host}`;
  let path = remote.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (path.toLowerCase().endsWith(`/${repository.toLowerCase()}`))
    path = path.slice(0, path.length - repository.length - 1);
  return `${remote.origin}${path.replace(/\/a$/u, "")}`;
}

export const definition = defineSourceControl({
  ...UNKNOWN_SOURCE_CONTROL_CLIENT,
  kind: KIND,
  label: "Gerrit",
  pickerLabel: "Gerrit",
  icon: {
    viewBox: "0 0 52 52",
    paths: [
      {
        d: "M4 0h32a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z",
        fill: "#D88989",
      },
      {
        d: "M16 12h32a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z",
        fill: "#83C88A",
      },
      { d: "M18 22h12v4H18zM34 22h12v4H34z", fill: "#9A4F4F" },
      {
        d: "M18 36h4v-4h4v4h4v4h-4v4h-4v-4h-4zM34 36h4v-4h4v4h4v4h-4v4h-4v-4h-4z",
        fill: "#397A43",
      },
    ],
  },
  changeRequest: {
    shortLabel: "change",
    shortLabelWithArticle: "a change",
    singular: "change",
    plural: "changes",
  },
  repositoryPathHint: "project",
  defaultCloneTransport: "https",
  parseChangeRequestUrl: (url) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const match = /^(.*?)\/(?:a\/)?c\/(.+)\/\+\/(\d+)(?:\/|$)/u.exec(url.pathname);
    const shorthand = /^(.*?)\/(?:a\/)?c\/(\d+)(?:\/|$)/u.exec(url.pathname);
    const hash = url.pathname === "/" ? /^#\/c\/(\d+)(?:\/|$)/u.exec(url.hash) : null;
    const number = Number(match?.[3] ?? shorthand?.[2] ?? hash?.[1]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    const project = match?.[2] ?? "";
    const parsed = match
      ? parseChangeRequestPath(url, /^(?:.*?)\/(?:a\/)?c\/(.+)\/\+\/(\d+)(?:\/|$)/u)
      : null;
    const prefix = match?.[1] ?? shorthand?.[1] ?? "";
    return {
      host: url.hostname.toLowerCase(),
      ...(url.port ? { authority: url.host.toLowerCase() } : {}),
      repository: parsed?.repository ?? "",
      number,
      repositoryUrl: `${url.origin}${prefix}${project ? `/${project}` : ""}`,
    };
  },
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (!Number.isSafeInteger(number) || number < 1 || repository.length === 0) return null;
    const root = webRoot(host, repository, webUrl ?? remoteUrl);
    return `${root.replace(/\/+$/u, "")}/c/${repository}/+/${number}`;
  },
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
