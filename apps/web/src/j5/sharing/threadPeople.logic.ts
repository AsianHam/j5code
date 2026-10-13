import type { SharingThreadGuest, SharingThreadPeople } from "@t3tools/contracts/j5";

type Member = SharingThreadPeople["members"][number];

/** Everyone who reaches one thread, sorted by how the People section shows them. */
export interface ThreadPeopleView {
  /** Guests whose grant is on this thread itself; their access is changed from the thread. */
  readonly direct: ReadonlyArray<SharingThreadGuest>;
  /** Guests who reach it only through its project. */
  readonly throughProject: ReadonlyArray<SharingThreadGuest>;
  /** Guests who reach it only through a thread above it: this one is an agent beneath that one. */
  readonly throughAncestor: ReadonlyArray<SharingThreadGuest>;
  /** Members reach every thread and hold no level. */
  readonly members: ReadonlyArray<Member>;
  /** The guest who is asking, when a guest is. */
  readonly you: SharingThreadGuest | null;
}

const reachesBy = (guest: SharingThreadGuest, via: SharingThreadGuest["grants"][number]["via"]) =>
  guest.grants.some((grant) => grant.via === via);

export function threadPeopleView(people: SharingThreadPeople): ThreadPeopleView {
  const direct = people.guests.filter((guest) => reachesBy(guest, "thread"));
  const rest = people.guests.filter((guest) => !reachesBy(guest, "thread"));
  return {
    direct,
    throughProject: rest.filter((guest) => reachesBy(guest, "project")),
    throughAncestor: rest.filter((guest) => !reachesBy(guest, "project")),
    members: people.members,
    you: people.guests.find((guest) => guest.you) ?? null,
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 people", for the header chip; `null` when only members reach the thread and it shows no chip. */
export function chipLabel(people: SharingThreadPeople): string | null {
  return people.guests.length === 0 ? null : count(people.guests.length, "person", "people");
}

/** "3 others", everyone who reaches the thread without a grant on it; `null` when there is no one. */
export function othersLabel(view: ThreadPeopleView): string | null {
  const others = view.members.length + view.throughProject.length + view.throughAncestor.length;
  return others === 0 ? null : count(others, "other", "others");
}

/** A member has a name only when the server recorded one; one without reads plainly. */
export const memberName = (member: Member) => member.displayName ?? "A member of this server";
export const guestName = (guest: SharingThreadGuest) => guest.displayName ?? "Unnamed guest";

/**
 * What a member is told before a guest's grant on a thread is removed. Removing it does not
 * always stop them reaching the thread: a grant on its project, or on a thread above it, may
 * still cover them.
 */
export function removeFromThreadWarning(guest: SharingThreadGuest, threadTitle: string): string {
  const name = guestName(guest);
  const still = reachesBy(guest, "project")
    ? ` ${name} will still reach it through its project; change that in the project's Sharing settings.`
    : reachesBy(guest, "ancestor")
      ? ` ${name} will still reach it through the thread it works for.`
      : " It leaves their list.";
  return `Remove ${name} from ${threadTitle}?${still} An image or file they already opened can stay readable for up to an hour.`;
}
