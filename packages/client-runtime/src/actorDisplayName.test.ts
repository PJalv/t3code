import { describe, expect, it } from "vite-plus/test";
import { actorDisplayName } from "./sourceControlClients.ts";

describe("actorDisplayName", () => {
  it("uses Gerrit display names without changing identity on other hosts", () => {
    const actor = { login: "jorge.sarez", name: "Jorge Suarez" };
    expect(actorDisplayName(actor, "gerrit")).toBe("Jorge Suarez");
    expect(actorDisplayName(actor, "github")).toBe("jorge.sarez");
    expect(actorDisplayName({ ...actor, name: "" }, "gerrit")).toBe("jorge.sarez");
    expect(actorDisplayName({ ...actor, name: null }, "gerrit")).toBe("jorge.sarez");
    expect(actorDisplayName(null, "gerrit")).toBeUndefined();
  });
});
