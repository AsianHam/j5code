import type {
  SharingDevice,
  SharingGrant,
  SharingGrantTarget,
  SharingOpenLink,
  SharingPerson,
} from "@t3tools/contracts/j5";

import { levelLabel, lifetimeLeft } from "./shareLink.logic";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Guests in the order they were brought in, and members, as the People page lists them. */
export function splitPeople(people: ReadonlyArray<SharingPerson>) {
  return {
    guests: people.filter((person) => person.kind === "guest"),
    members: people.filter((person) => person.kind === "member"),
  };
}

const grantCounts = (grants: ReadonlyArray<SharingGrant>, level: SharingGrant["level"]) => {
  const held = grants.filter((grant) => grant.level === level);
  const projects = held.filter((grant) => grant.target.kind === "project").length;
  const threads = held.length - projects;
  const parts = [
    ...(projects > 0 ? [count(projects, "project", "projects")] : []),
    ...(threads > 0 ? [count(threads, "thread", "threads")] : []),
  ];
  return parts.length === 0 ? null : `${levelLabel(level)} on ${parts.join(" and ")}`;
};

/**
 * The line under a guest's name: "Collaborate on 1 thread · View on 1 project · joined by link ·
 * 2 devices". A guest with nothing yet says so, since they reach nothing until a member shares.
 */
export function guestSummary(person: SharingPerson): string {
  const access = [
    grantCounts(person.grants, "collaborate"),
    grantCounts(person.grants, "view"),
  ].filter((part): part is string => part !== null);
  return [
    ...(access.length === 0 ? ["Nothing shared yet"] : access),
    ...(person.joinedOpenLinkId === null ? [] : ["joined by link"]),
    person.devices.length === 0 ? "no devices" : count(person.devices.length, "device", "devices"),
  ].join(" · ");
}

/** "Desktop · Linux · Chrome", from what the device said of itself when it paired. */
export function deviceLabel(device: SharingDevice): string {
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- session metadata a device gave of itself, not an RPC client
  const { deviceType, os, browser } = device.client;
  const parts = [
    deviceType === "unknown" ? null : `${deviceType[0]?.toUpperCase()}${deviceType.slice(1)}`,
    os ?? null,
    browser ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? "Unknown device" : parts.join(" · ");
}

/** "View · 6 days left · 1 person joined", for a join link's row. */
export function joinLinkRowMeta(link: SharingOpenLink, nowMs: number): string {
  const left = lifetimeLeft(link.expiresAt.epochMilliseconds, nowMs);
  return [
    "View",
    left === null ? "expired" : `${left} left`,
    link.joined.length === 0
      ? "nobody joined yet"
      : `${count(link.joined.length, "person", "people")} joined`,
  ].join(" · ");
}

export const sameTarget = (left: SharingGrantTarget, right: SharingGrantTarget) =>
  left.kind === "project"
    ? right.kind === "project" && left.projectId === right.projectId
    : right.kind === "thread" && left.threadId === right.threadId;

/** Everyone holding a grant on exactly this project or thread, with the level each holds. */
export function peopleWithGrantOn(
  people: ReadonlyArray<SharingPerson>,
  target: SharingGrantTarget,
): ReadonlyArray<{ readonly person: SharingPerson; readonly grant: SharingGrant }> {
  return people.flatMap((person) => {
    const grant = person.grants.find((held) => sameTarget(held.target, target));
    return grant === undefined ? [] : [{ person, grant }];
  });
}

/** What a member is told before a person is removed altogether. */
export function removePersonWarning(person: SharingPerson): string {
  const name = person.displayName ?? "this person";
  return `Remove ${name}? Everything shared with them is taken away, their devices are signed out and their unused links stop working. An image or file they already opened can stay readable for up to an hour.`;
}

/** What a member is told before one grant is removed. */
export function removeGrantWarning(name: string, title: string): string {
  return `Stop sharing ${title} with ${name}? It leaves their list. An image or file they already opened can stay readable for up to an hour.`;
}
