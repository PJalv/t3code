import type { GerritAccount } from "@t3tools/contracts";

export function gerritAccountActor(account: typeof GerritAccount.Type) {
  const login =
    account.username?.trim() ||
    account.email?.trim() ||
    (account._account_id === undefined ? null : String(account._account_id)) ||
    account.name?.trim() ||
    account.display_name?.trim();
  return !login
    ? null
    : {
        login,
        name:
          account.name?.trim() ||
          account.display_name?.trim() ||
          account.username?.trim() ||
          account.email?.trim() ||
          null,
        avatarUrl: account.avatars?.[0]?.url ?? null,
      };
}
