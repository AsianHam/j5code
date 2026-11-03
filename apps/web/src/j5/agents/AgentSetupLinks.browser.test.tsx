import {
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AgentSetupLinks } from "./AgentSetupLinks";

const scope = { project: "repo:review", machine: "remote-server", checkout: "/repo/worktree" };
const initialEntry = `/settings/personas?${new URLSearchParams(scope)}`;

function desktopHistory(href = `file:///app/index.html#${initialEntry}`) {
  const location = new URL(href);
  const history = {
    state: undefined as unknown,
    length: 1,
    pushState(state: unknown, _title: string, href?: string) {
      this.state = state;
      if (href) location.href = new URL(href, location).href;
      this.length++;
    },
    replaceState(state: unknown, _title: string, href?: string) {
      this.state = state;
      if (href) location.href = new URL(href, location).href;
    },
  };
  return {
    location,
    history: createHashHistory({
      window: { location, history, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    }),
  };
}

function settingsRouter(history: ReturnType<typeof createMemoryHistory>) {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/personas",
    validateSearch: (search) => search,
    component: AgentSetupLinks,
  });
  return createRouter({ routeTree: root.addChildren([settings]), history });
}

describe("Agent Setup section navigation", () => {
  it.each([
    { desktop: false, label: "web" },
    { desktop: true, label: "desktop" },
  ])(
    "preserves the settings route and scope when following section links on $label",
    async ({ desktop }) => {
      const shell = desktop ? desktopHistory() : null;
      const history = shell?.history ?? createMemoryHistory({ initialEntries: [initialEntry] });
      const router = settingsRouter(history);
      try {
        await router.load();
        await using screen = await render(<RouterProvider router={router} />, { router: false });
        for (const section of ["crews", "playbooks", "personas"]) {
          const label =
            section === "crews" ? "Crews" : section === "playbooks" ? "Playbooks" : "Personas";
          const link = [...screen.container.querySelectorAll("a")].find(
            (entry) => entry.textContent === label,
          )!;
          const destination = new URL(
            link.getAttribute("href")!,
            shell?.location ?? "http://localhost",
          );
          const followed = desktop
            ? desktopHistory(destination.href).history
            : createMemoryHistory({
                initialEntries: [destination.pathname + destination.search + destination.hash],
              });
          try {
            const reloaded = settingsRouter(followed);
            await reloaded.load();
            expect(reloaded.state.location.pathname).toBe("/settings/personas");
            expect(reloaded.state.location.search).toEqual(scope);
            expect(reloaded.state.location.hash).toBe(section);
          } finally {
            followed.destroy();
          }
        }
      } finally {
        history.destroy();
      }
    },
  );
});
