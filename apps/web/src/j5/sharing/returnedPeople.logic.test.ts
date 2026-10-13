import type { SharingPerson } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { peopleWithReturnedRows } from "./returnedPeople.logic";

const person = (personId: string, displayName: string) =>
  ({ personId, displayName }) as unknown as SharingPerson;

describe("the row a request returned", () => {
  const listed = [person("p1", "Priya"), person("p2", "Sam")];

  it("is shown in place of the list's own until the list is read again", () => {
    const returned = new Map([["p2", person("p2", "Sam T.")]]);
    expect(peopleWithReturnedRows(listed, returned).map((row) => row.displayName)).toEqual([
      "Priya",
      "Sam T.",
    ]);
  });

  it("adds no one the list does not hold, and changes nothing when there is none", () => {
    expect(peopleWithReturnedRows(listed, new Map([["p9", person("p9", "Gone")]]))).toHaveLength(2);
    expect(peopleWithReturnedRows(listed, new Map())).toBe(listed);
  });
});
