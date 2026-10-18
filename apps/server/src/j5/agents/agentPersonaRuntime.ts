import * as Effect from "effect/Effect";
import { isAgentPersonaAuthorityPolicy, type OrchestrationV2AppThread } from "@t3tools/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { getBuiltInAgentPersonaInstructions } from "./agentPersonaPrompts.ts";
import {
  AgentPersonaLibraryError,
  makeAgentPersonaLibrary,
  type createAgentPersonaLibrary,
} from "./agentPersonaLibrary.ts";
import {
  providerCanEnforceAgentPersonaAuthority,
  translateAgentPersonaProviderPolicy,
} from "./agentPersonaProviderPolicy.ts";
import { agentPersonaArtifactInstructions } from "./agentPersonaArtifacts.ts";
import { makeCrewSeatLookup, withCrewSeatQuestions } from "../a2a/crewSeatRuntime.ts";

/**
 * Read-only personas run with shell approvals disabled ("approval policy never"). Models have read
 * that as "no human can approve anything" and refused gated platform work, so the runtime says
 * plainly that platform gates are resolved in the app, not by the sandbox.
 */
const PLATFORM_TOOLS_NOTE =
  "Platform tools on the t3-code MCP server stay available under every sandbox and approval policy. Their human gates (for example j5_propose_crew) are resolved by the user in the app, not by a shell approval, so an approval policy of never does not block them.";

/** Persona instructions express behavior; the translated sandbox supplies the actual runtime boundary. */
export const resolveAgentPersonaRuntime = Effect.fn("resolveAgentPersonaRuntime")(function* (
  thread: Pick<OrchestrationV2AppThread, "agentPersonaAssignment" | "runtimeMode"> &
    Partial<Pick<OrchestrationV2AppThread, "id">>,
  library: ReturnType<typeof createAgentPersonaLibrary>,
) {
  const assignment = thread.agentPersonaAssignment;
  if (assignment === undefined) return { runtimeMode: thread.runtimeMode };
  // A policy only a newer server knows fails here on every path, never as some other policy.
  if (!isAgentPersonaAuthorityPolicy(assignment.authorityPolicy))
    return yield* new AgentPersonaLibraryError({
      message: `The assigned persona runtime policy ${assignment.authorityPolicy} is not supported by this server.`,
    });
  let instructions: string | undefined;
  if (assignment.definitionDigest === undefined) {
    instructions = getBuiltInAgentPersonaInstructions(assignment);
  } else {
    const definition = yield* library.readSnapshot(assignment);
    if (
      !definition.authority.allowedPolicies.some(
        (policy) => policy === assignment.authorityPolicy,
      ) ||
      (assignment.runtimeModeOverride === undefined &&
        !providerCanEnforceAgentPersonaAuthority(
          assignment.resolvedDriver,
          assignment.authorityPolicy,
        ))
    ) {
      return yield* new AgentPersonaLibraryError({
        message: "The assigned persona runtime permissions are unsupported.",
      });
    }
    // The persona's own text is the whole behavior contract; J5 appends no hidden rules (#439).
    instructions = `${definition.instructions}\n\n${PLATFORM_TOOLS_NOTE}`;
    // Declared handoffs bind to the shared artifacts system; the section names the exact path.
    const artifactSection =
      thread.id === undefined ? undefined : agentPersonaArtifactInstructions(definition, thread.id);
    if (artifactSection !== undefined) instructions = `${instructions}\n\n${artifactSection}`;
  }
  return {
    ...(assignment.runtimeModeOverride === undefined
      ? translateAgentPersonaProviderPolicy(assignment.authorityPolicy, assignment.resolvedDriver)
      : { runtimeMode: assignment.runtimeModeOverride }),
    ...(instructions === undefined ? {} : { agentPersonaInstructions: instructions }),
  };
});

/** The thread's full runtime policy: persona sandbox and instructions when assigned, the plain mode otherwise. */
export const resolveAgentPersonaRuntimePolicy = (
  input: { readonly thread: OrchestrationV2AppThread; readonly cwd: string | null },
  library: ReturnType<typeof createAgentPersonaLibrary>,
) =>
  resolveAgentPersonaRuntime(input.thread, library).pipe(
    Effect.map((policy) =>
      ProviderAdapterV2RuntimePolicy.make({
        ...policy,
        interactionMode: input.thread.interactionMode,
        cwd: input.cwd,
      }),
    ),
  );

export interface AgentPersonaRuntimePolicyInput {
  readonly thread: OrchestrationV2AppThread;
  readonly cwd: string | null;
}

/**
 * Resolver for the upstream RuntimePolicy layers: builds the library and the Crew seat lookup once
 * and maps failures through the caller-supplied error constructor, so the upstream file adds no
 * persona logic. A live Crew seat's policy is marked so adapters withhold native question tools.
 */
export const makeAgentPersonaRuntimePolicyResolver = <E>(
  toError: (input: AgentPersonaRuntimePolicyInput, cause: unknown) => E,
) =>
  Effect.gen(function* () {
    const library = yield* makeAgentPersonaLibrary;
    const isCrewSeat = yield* makeCrewSeatLookup;
    return (input: AgentPersonaRuntimePolicyInput) =>
      resolveAgentPersonaRuntimePolicy(input, library).pipe(
        Effect.flatMap((policy) =>
          isCrewSeat(input.thread).pipe(
            Effect.map((seat) => (seat ? withCrewSeatQuestions(policy) : policy)),
          ),
        ),
        Effect.mapError((cause) => toError(input, cause)),
      );
  });
