import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "../baseSchemas.ts";

/**
 * J5-owned skill catalog wire schemas. J5 handles environment selection,
 * catalog validation, dependency resolution, installation targets, link
 * ownership, reconciliation, state, Git updates, and rendering. Catalog
 * repositories contain only content.
 */

export const SkillCatalogSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
});
export type SkillCatalogSkill = typeof SkillCatalogSkill.Type;

export const SkillCatalogGroup = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  depends: Schema.Array(TrimmedNonEmptyString),
  skills: Schema.Array(SkillCatalogSkill),
});
export type SkillCatalogGroup = typeof SkillCatalogGroup.Type;

export const SkillCatalogStatus = Schema.Struct({
  catalogDir: TrimmedNonEmptyString,
  groups: Schema.Array(SkillCatalogGroup),
  /** Saved explicit selections, not verified inventory or dependency-expanded groups. */
  selectedGroups: Schema.Array(TrimmedNonEmptyString),
  targets: Schema.Array(TrimmedNonEmptyString),
  git: Schema.Struct({
    upstream: Schema.NullOr(TrimmedNonEmptyString),
    dirty: Schema.Boolean,
  }),
  warnings: Schema.Array(Schema.String),
});
export type SkillCatalogStatus = typeof SkillCatalogStatus.Type;

/** A specific link observed during Apply, requiring explicit confirmation to replace. */
export const SkillCatalogReplacement = Schema.Struct({
  linkPath: TrimmedNonEmptyString,
  currentTarget: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  identity: TrimmedNonEmptyString,
});
export type SkillCatalogReplacement = typeof SkillCatalogReplacement.Type;

export const SkillCatalogConflict = Schema.Struct({
  skill: TrimmedNonEmptyString,
  linkPath: TrimmedNonEmptyString,
  detail: Schema.String,
  replacement: Schema.optional(SkillCatalogReplacement),
});
export type SkillCatalogConflict = typeof SkillCatalogConflict.Type;

export const SkillCatalogFailedLink = Schema.Struct({
  linkPath: Schema.String,
  error: Schema.String,
});
export type SkillCatalogFailedLink = typeof SkillCatalogFailedLink.Type;

/** Link counts, not distinct skills. */
export const SkillCatalogApplyResult = Schema.Struct({
  selectedGroups: Schema.Array(TrimmedNonEmptyString),
  installed: NonNegativeInt,
  removed: NonNegativeInt,
  unchanged: NonNegativeInt,
  conflicts: Schema.Array(SkillCatalogConflict),
  failed: Schema.Array(SkillCatalogFailedLink),
});
export type SkillCatalogApplyResult = typeof SkillCatalogApplyResult.Type;

export const SkillCatalogUpdateResult = Schema.Struct({
  upstream: TrimmedNonEmptyString,
});
export type SkillCatalogUpdateResult = typeof SkillCatalogUpdateResult.Type;

export class SkillCatalogError extends Schema.TaggedError<SkillCatalogError>()(
  "SkillCatalogError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.Literal("source-changed")),
    result: Schema.optional(SkillCatalogApplyResult),
  },
) {}

// Skill catalog RPCs. These ride the upstream WebSocket RPC transport via one
// `WsRpcGroup.merge(...)` call so environment scoping, remote connections, and
// mobile keep working without a second wire path, while every definition stays here.

export const J5_SKILL_CATALOG_WS_METHODS = {
  getSkillCatalogStatus: "j5.skills.status",
  applySkillCatalogGroups: "j5.skills.apply",
  updateSkillCatalog: "j5.skills.update",
} as const;

/**
 * Transport context, not a skill-management concept: prevents an old page from
 * applying selections against a newly configured source.
 */
export const SkillCatalogExpectedSource = Schema.Struct({
  expectedSource: TrimmedString,
});

export const J5SkillCatalogRpcSchemas = {
  getSkillCatalogStatus: {
    input: SkillCatalogExpectedSource,
    output: SkillCatalogStatus,
  },
  applySkillCatalogGroups: {
    input: Schema.Struct({
      expectedSource: TrimmedString,
      groups: Schema.Array(TrimmedNonEmptyString),
      replacements: Schema.optional(Schema.Array(SkillCatalogReplacement)),
    }),
    output: SkillCatalogApplyResult,
  },
  updateSkillCatalog: {
    input: SkillCatalogExpectedSource,
    output: SkillCatalogUpdateResult,
  },
} as const;

const skillCatalogErrors = Schema.Union([EnvironmentAuthorizationError, SkillCatalogError]);

export const WsJ5GetSkillCatalogStatusRpc = Rpc.make(
  J5_SKILL_CATALOG_WS_METHODS.getSkillCatalogStatus,
  {
    payload: J5SkillCatalogRpcSchemas.getSkillCatalogStatus.input,
    success: J5SkillCatalogRpcSchemas.getSkillCatalogStatus.output,
    error: skillCatalogErrors,
  },
);

export const WsJ5ApplySkillCatalogGroupsRpc = Rpc.make(
  J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups,
  {
    payload: J5SkillCatalogRpcSchemas.applySkillCatalogGroups.input,
    success: J5SkillCatalogRpcSchemas.applySkillCatalogGroups.output,
    error: skillCatalogErrors,
  },
);

export const WsJ5UpdateSkillCatalogRpc = Rpc.make(J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog, {
  payload: J5SkillCatalogRpcSchemas.updateSkillCatalog.input,
  success: J5SkillCatalogRpcSchemas.updateSkillCatalog.output,
  error: skillCatalogErrors,
});

/** Merged into `WsRpcGroup` by one appended call; no other upstream registration exists. */
export const J5SkillCatalogRpcGroup = RpcGroup.make(
  WsJ5GetSkillCatalogStatusRpc,
  WsJ5ApplySkillCatalogGroupsRpc,
  WsJ5UpdateSkillCatalogRpc,
);
