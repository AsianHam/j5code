import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useSharedConversationEntries } from "./sharedTimeline";

// The record and the people read are atom values, the same objects until the server answers again.
const authors = {
  record: { shared: false, authors: [], answers: [] },
  readAt: 1,
  failed: false,
  refresh: vi.fn(),
};
const person = (level: "owner" | "collaborator", you: boolean) => ({
  personId: null,
  name: null,
  level,
  via: [],
  firstOwner: you,
  you,
});
const onlyMe = { data: { people: [person("owner", true)] }, error: null };
const twoWriters = {
  data: { people: [person("owner", true), person("collaborator", false)] },
  error: null,
};
const reach = { people: onlyMe };
function setup() {
  authors.refresh.mockClear();
  reach.people = onlyMe;
}
vi.mock(import("./sharedConversation"), async (original) => ({
  ...(await original()),
  useThreadAuthors: (() => authors) as never,
}));
vi.mock(import("./scopeAccess"), async (original) => ({
  ...(await original()),
  useScopePeople: (() => reach.people) as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const entries = [
  {
    id: "entry-1",
    kind: "message",
    message: { id: "message-1", role: "user", text: "Hello", createdBy: "user" },
  },
];

describe("useSharedConversationEntries", () => {
  it("hands the timeline the same entries while nothing it reads has changed", async () => {
    setup();
    const seen: Array<ReadonlyArray<unknown>> = [];
    function Probe(props: { readonly tick: number }) {
      seen.push(useSharedConversationEntries(threadRef, entries));
      return <span>{props.tick}</span>;
    }
    // The hook reads no route.
    await using screen = await render(<Probe tick={1} />, { router: false });
    const settled = seen.length;
    await screen.rerender(<Probe tick={2} />);
    expect(seen.length).toBeGreaterThan(settled);
    expect(seen.at(-1)).toBe(seen[settled - 1]);
  });

  it("keeps a message on screen when the thread becomes shared, and asks about it once", async () => {
    setup();
    const seen: Array<ReadonlyArray<{ readonly id: string }>> = [];
    function Probe(props: { readonly tick: number }) {
      seen.push(useSharedConversationEntries(threadRef, entries));
      return <span>{props.tick}</span>;
    }
    // The hook reads no route.
    await using screen = await render(<Probe tick={1} />, { router: false });
    expect(authors.refresh).not.toHaveBeenCalled();
    reach.people = twoWriters;
    await screen.rerender(<Probe tick={2} />);
    expect(seen.at(-1)?.map((entry) => entry.id)).toEqual(["entry-1"]);
    expect(authors.refresh).toHaveBeenCalledTimes(1);
  });
});
