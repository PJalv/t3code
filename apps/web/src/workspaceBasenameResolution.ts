import { needsWorkspaceBasenameLookup } from "./workspaceBasenameLookup";

export function collectWorkspaceBasenameCandidates(paths: Iterable<string>): Set<string> {
  return new Set([...paths].filter(needsWorkspaceBasenameLookup));
}

export function cachedWorkspaceBasenameLookup(
  cache: Map<string, Promise<string | null>>,
  name: string,
  lookup: (name: string) => Promise<string | null>,
): Promise<string | null> {
  let result = cache.get(name);
  if (!result) {
    result = lookup(name).catch(() => null);
    cache.set(name, result);
  }
  return result;
}
