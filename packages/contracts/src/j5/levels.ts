import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "../auth.ts";
import { ProjectId, ThreadId } from "../baseSchemas.ts";

/**
 * A person's level and the scope it is held at (docs/j5/product/features/people-and-access.md).
 * A Viewer reads, a Collaborator writes within their scope, and an Owner, at server scope only,
 * also configures and shares the server.
 */
export const PersonLevel = Schema.Literals(["viewer", "collaborator", "owner"]);
export type PersonLevel = typeof PersonLevel.Type;

export const PersonScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("server") }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type PersonScope = typeof PersonScope.Type;

const LEVEL_RANK: Record<PersonLevel, number> = { viewer: 1, collaborator: 2, owner: 3 };

/** The higher of two levels; a missing level is lower than any. */
export const higherLevel = (
  a: PersonLevel | null | undefined,
  b: PersonLevel | null | undefined,
): PersonLevel | null => {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
};

export const highestLevel = (levels: ReadonlyArray<PersonLevel>): PersonLevel | null =>
  levels.reduce<PersonLevel | null>((held, level) => higherLevel(held, level), null);

/** Whether `held` is `wanted` or higher. */
export const levelReaches = (held: PersonLevel | null | undefined, wanted: PersonLevel) =>
  held !== null && held !== undefined && LEVEL_RANK[held] >= LEVEL_RANK[wanted];

/**
 * The one place each level maps onto upstream's permissions (People and access AC16); upstream's
 * labels for them are in `packages/shared/src/authScopeOptions.ts`. A device holds its person's
 * highest level's set, cut to any ceiling it was paired with. When upstream reshapes its
 * permissions, this table changes and the model does not.
 */
export const LEVEL_PERMISSIONS: Record<PersonLevel, ReadonlyArray<AuthEnvironmentScope>> = {
  viewer: [AuthOrchestrationReadScope],
  collaborator: [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthPreviewOperateScope,
    AuthDiagnosticsReadScope,
    AuthTerminalReadScope,
    AuthTerminalOperateScope,
    AuthSourceControlWriteScope,
    AuthFilesystemReadScope,
    AuthFilesystemWriteScope,
    AuthRelayReadScope,
  ],
  owner: AuthGrantScope.literals,
};

/**
 * The permissions a device of a person at `level` holds: the level's set, cut to the device's
 * ceiling when it has one, in the level table's order. A person who holds no level any more is
 * given a Viewer's permissions, and their scope is empty.
 */
export const devicePermissions = (
  level: PersonLevel | null,
  ceiling: ReadonlyArray<string> | null,
): ReadonlyArray<AuthEnvironmentScope> => {
  const granted = LEVEL_PERMISSIONS[level ?? "viewer"];
  return ceiling === null ? granted : granted.filter((scope) => ceiling.includes(scope));
};

/** Whether two permission sets hold the same permissions, in any order. */
export const samePermissions = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((scope) => b.includes(scope));

/**
 * The level a device the server cannot place is given when its person is new (AC5): Owner if it
 * holds Manage access, Collaborator if it holds Operate tasks, Viewer otherwise.
 */
export const levelForUnknownDevice = (scopes: ReadonlyArray<string>): PersonLevel =>
  scopes.includes(AuthAccessWriteScope)
    ? "owner"
    : scopes.includes(AuthOrchestrationOperateScope)
      ? "collaborator"
      : "viewer";
