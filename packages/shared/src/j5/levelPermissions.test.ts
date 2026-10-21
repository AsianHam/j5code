import { AuthGrantScope } from "@t3tools/contracts";
import { LEVEL_PERMISSIONS, devicePermissions } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { AUTH_SCOPE_OPTIONS } from "../authScopeOptions.ts";

const titles = (scopes: ReadonlyArray<string>) =>
  scopes.map((scope) => AUTH_SCOPE_OPTIONS.find((option) => option.scope === scope)?.title);

// People and access AC16 lists each level's permissions by upstream's names. A change here is a
// change to what every device of that level holds, and to the definition.
describe("level permissions", () => {
  it("gives each level exactly the permissions the definition names", () => {
    expect(titles(LEVEL_PERMISSIONS.viewer)).toEqual(["View environment"]);
    expect(titles(LEVEL_PERMISSIONS.collaborator)).toEqual([
      "View environment",
      "Operate tasks",
      "Control previews",
      "View diagnostics and usage",
      "View terminals",
      "Use terminals",
      "Change source control",
      "Read files",
      "Write files",
      "View relay",
    ]);
    expect([...LEVEL_PERMISSIONS.owner].toSorted()).toEqual(
      [...AuthGrantScope.literals].toSorted(),
    );
  });

  it("cuts a level's permissions to a device's ceiling and never adds to it", () => {
    expect(devicePermissions("owner", ["orchestration:read", "terminal:operate"])).toEqual([
      "orchestration:read",
      "terminal:operate",
    ]);
    expect(devicePermissions("viewer", ["orchestration:read", "access:write"])).toEqual([
      "orchestration:read",
    ]);
    expect(devicePermissions(null, null)).toEqual(["orchestration:read"]);
  });
});
