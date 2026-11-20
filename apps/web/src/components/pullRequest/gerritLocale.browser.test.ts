import { expect, it } from "vite-plus/test";
import { getTranslationsSnapshot, initializeGTSPA } from "gt-react";
import german from "../../i18n/translations/de.json";
import { m, setActiveLocale } from "../../i18n/messages";
import { gerritRequirementStatus } from "./PullRequestGerritSummary";

it("uses the loaded locale for Gerrit requirement status and restores English", async () => {
  await initializeGTSPA({
    defaultLocale: "en",
    locales: ["en", "de"],
    locale: "en",
    loadTranslations: async () => german,
    cacheExpiryTime: null,
  });
  await getTranslationsSnapshot("de");
  try {
    setActiveLocale("de");
    expect(gerritRequirementStatus("satisfied", m)).toBe("Erfüllt");
    expect(gerritRequirementStatus("unsatisfied", m)).toBe("Nicht erfüllt");
    expect(gerritRequirementStatus(null, m)).toBe("Nicht verfügbar");
  } finally {
    setActiveLocale("en");
  }
  expect(gerritRequirementStatus("satisfied", m)).toBe("Satisfied");
});
