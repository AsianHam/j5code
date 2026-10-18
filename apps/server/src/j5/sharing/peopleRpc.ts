import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { J5ActionError, J5_PEOPLE_WS_METHODS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Listing people and links needs upstream's permission to see who has access, and every change to
 * people, levels, devices and links needs its Manage access, which only an Owner's devices hold.
 * Renaming oneself and reading who reaches a thread or project need only what every device holds.
 */
export const PEOPLE_RPC_SCOPES = {
  [J5_PEOPLE_WS_METHODS.listPeople]: AuthAccessReadScope,
  [J5_PEOPLE_WS_METHODS.listScopePeople]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.setLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removeLevel]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.removePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.renamePerson]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.renameSelf]: AuthOrchestrationReadScope,
  [J5_PEOPLE_WS_METHODS.revokeDevice]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.createLink]: AuthAccessWriteScope,
  [J5_PEOPLE_WS_METHODS.listLinks]: AuthAccessReadScope,
  [J5_PEOPLE_WS_METHODS.revokeLink]: AuthAccessWriteScope,
} as const;

// The wire is fixed so the web client can be built against it; its handlers are links and
// people's, built next.
const notYet = Effect.fail(
  new J5ActionError({ code: "NotBuiltYet", message: "This is not available on this server yet." }),
);

export const makePeopleRpcHandlers = () => ({
  [J5_PEOPLE_WS_METHODS.listPeople]: () => notYet,
  [J5_PEOPLE_WS_METHODS.listScopePeople]: () => notYet,
  [J5_PEOPLE_WS_METHODS.subscribeScopePeopleChanges]: () => Stream.fromEffect(notYet),
  [J5_PEOPLE_WS_METHODS.setLevel]: () => notYet,
  [J5_PEOPLE_WS_METHODS.removeLevel]: () => notYet,
  [J5_PEOPLE_WS_METHODS.removePerson]: () => notYet,
  [J5_PEOPLE_WS_METHODS.renamePerson]: () => notYet,
  [J5_PEOPLE_WS_METHODS.renameSelf]: () => notYet,
  [J5_PEOPLE_WS_METHODS.revokeDevice]: () => notYet,
  [J5_PEOPLE_WS_METHODS.createLink]: () => notYet,
  [J5_PEOPLE_WS_METHODS.listLinks]: () => notYet,
  [J5_PEOPLE_WS_METHODS.revokeLink]: () => notYet,
});
