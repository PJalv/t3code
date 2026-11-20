// This identity is compiled into both SEA graphs; runtime environment variables cannot change it.
declare const __T3CODE_BUILD_PROFILE__: "standard" | "gerrit-beta" | undefined;
export const isGerritBeta =
  typeof __T3CODE_BUILD_PROFILE__ !== "undefined" && __T3CODE_BUILD_PROFILE__ === "gerrit-beta";

export const gerritBetaRefusal =
  "This Gerrit beta is a portable, foreground-only build. Install, update, service and desktop handoffs are disabled. Use the matching fork archive; do not use the official installer.";
