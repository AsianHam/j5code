/**
 * Which server, if any, the startup question is asked for now. It is asked only of a connection
 * that can manage access on a server whose owner has no name (`null`; `undefined` means the
 * connection was not told, as a guest's is not), one server at a time, in the order they are
 * listed, and not again this session for a server the person answered "Not now" for.
 */
export function serverToAskOwnerNameFor<Id>(
  servers: ReadonlyArray<{
    readonly id: Id;
    readonly ownerName: string | null | undefined;
    readonly canManage: boolean;
  }>,
  askedLater: ReadonlySet<Id>,
): Id | null {
  return (
    servers.find(
      (server) => server.ownerName === null && server.canManage && !askedLater.has(server.id),
    )?.id ?? null
  );
}

/**
 * What a flow that needs the owner's name does when the connection was told there is none. That
 * answer is as old as the connection, and another client may have set a name since, so the list
 * of people is read first: "wait" until it answers, "proceed" with the name it holds, and "ask"
 * only when the server still has none (or cannot be asked, when its refusal decides).
 */
export function ownerNameCheck(input: {
  /** The name this client knows: told at connect, or set here since. */
  readonly known: string | null | undefined;
  /** The freshly read list's name for the owner; `undefined` until the list answers. */
  readonly listed: string | null | undefined;
  readonly listFailed: boolean;
}): "proceed" | "wait" | "ask" {
  if (input.known !== null) return "proceed";
  if (input.listFailed) return "ask";
  if (input.listed === undefined) return "wait";
  return input.listed === null ? "ask" : "proceed";
}
