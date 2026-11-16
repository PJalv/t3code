import { GerritChangeNumber } from "@t3tools/contracts";

/** Parse only routes under a configured installation; the URL is never fetched. */
export function changeFromUrl(
  urlText: string,
  installationText: string,
): { readonly number: typeof GerritChangeNumber.Type; readonly project?: string } | null {
  try {
    const url = new URL(urlText);
    const installation = new URL(installationText);
    const raw = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(urlText);
    const prefix = installation.pathname.replace(/\/+$/, "");
    const legacy = url.hash.startsWith("#/c/");
    if (
      raw === null ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      raw[1]!.includes("@") ||
      installation.username !== "" ||
      installation.password !== "" ||
      installation.search !== "" ||
      installation.hash !== "" ||
      url.origin !== installation.origin ||
      decodeURIComponent(raw[2]!)
        .split(/[\\/]/)
        .some((part) => part === "." || part === "..") ||
      (urlText.includes("?") && url.search === "") ||
      (urlText.includes("#") && url.hash === "") ||
      [...url.searchParams.keys()].some((key) => key !== "usp" && key !== "tab") ||
      (url.hash !== "" && !legacy && !/^#[a-z\d][a-z\d_.:-]*$/i.test(url.hash)) ||
      (legacy &&
        (url.pathname.replace(/\/+$/, "") !== prefix ||
          decodeURIComponent(url.hash.slice(1))
            .split(/[\\/]/)
            .some((part) => part === "." || part === "..")))
    )
      return null;
    if (!legacy && prefix !== "" && !url.pathname.startsWith(`${prefix}/`)) return null;
    const remainder = legacy
      ? url.hash.slice(1)
      : prefix === ""
        ? url.pathname
        : url.pathname.slice(prefix.length);
    const match =
      /^\/(?:c\/(.+?)\/\+\/|(.+?)\/\+\/|(?:c\/)?)(\d+)(?:\/(\d+|edit)(?:\/([^?#]+))?)?\/?$/.exec(
        remainder,
      );
    if (match === null) return null;
    const project = match[1] ?? match[2];
    const decoded = project === undefined ? undefined : decodeURIComponent(project);
    if (
      decoded !== undefined &&
      (!decoded ||
        decoded.includes("\\") ||
        decoded.split("/").some((part) => !part || part === "." || part === ".." || part === "+"))
    )
      return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return decoded === undefined
      ? { number: GerritChangeNumber.make(number) }
      : { number: GerritChangeNumber.make(number), project: decoded };
  } catch {
    return null;
  }
}

export function changeNumberFromUrl(
  urlText: string,
  installationText: string,
  expectedProject: string,
) {
  const parsed = changeFromUrl(urlText, installationText);
  return parsed?.project === expectedProject ? parsed.number : null;
}

/** Reject overlapping installation paths rather than selecting one by ordering. */
export function uniqueChangeFromUrl(url: string, installations: readonly string[]) {
  const matches = installations.flatMap((installation) => {
    const parsed = changeFromUrl(url, installation);
    return parsed === null ? [] : [{ installation, ...parsed }];
  });
  if (matches.length !== 1) return null;
  // A number-only route can otherwise hide an overlapping installation prefix.
  const selected = matches[0]!;
  const target = new URL(url);
  const containing = installations.filter((text) => {
    try {
      const base = new URL(text);
      const prefix = base.pathname.replace(/\/+$/, "");
      return (
        base.origin === target.origin &&
        (prefix === "" || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
      );
    } catch {
      return false;
    }
  });
  return containing.length === 1 ? selected : null;
}
