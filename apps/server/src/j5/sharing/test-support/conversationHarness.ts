import type { OrchestrationV2Command, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Access from "../Access.ts";
import * as SharedConversation from "../SharedConversation.ts";
import * as SharedThreads from "../SharedThreads.ts";
import { recordsLayer } from "./accessHarness.ts";

/**
 * The commands the platform handed upstream, and upstream's live event tail, in place of
 * upstream's thread service.
 */
export class Upstream extends Context.Service<
  Upstream,
  {
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2Command>>;
    readonly events: PubSub.PubSub<OrchestrationV2DomainEvent>;
  }
>()("t3/j5/sharing/test-support/conversationHarness/Upstream") {}

const upstreamLayer = Layer.effect(
  Upstream,
  Effect.gen(function* () {
    return Upstream.of({
      dispatched: yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]),
      events: yield* PubSub.unbounded<OrchestrationV2DomainEvent>(),
    });
  }),
);

const threadsLayer = Layer.effect(
  ThreadManagementService,
  Effect.map(Upstream, (upstream) =>
    ThreadManagementService.of({
      dispatch: (command: OrchestrationV2Command) =>
        Ref.update(upstream.dispatched, (sent) => [...sent, command]).pipe(Effect.as({} as never)),
      streamDomainEvents: Stream.fromPubSub(upstream.events),
    } as unknown as ThreadManagementService["Service"]),
  ),
);

/**
 * People, levels, devices and the access core, with shared conversations over them and the
 * write hook that records a thread shared, over one in-memory database.
 */
export const conversationLayer = SharedConversation.layer.pipe(
  Layer.provideMerge(SharedThreads.layer),
  Layer.provide(threadsLayer),
  Layer.provideMerge(upstreamLayer),
  Layer.provideMerge(
    Access.layer.pipe(
      Layer.provide(SharedThreads.accessWriteHookLayer),
      Layer.provideMerge(recordsLayer),
    ),
  ),
);

/** An access core no one changes, for a runtime built without people. */
export const quietAccessLayer = Layer.mock(Access.Access)({
  subscribe: PubSub.unbounded<Access.AccessChange>().pipe(Effect.flatMap(PubSub.subscribe)),
});
