import { Link } from "@tanstack/react-router";

export function AgentSetupLinks() {
  return (
    <nav aria-label="Agent Setup sections" className="flex gap-4 px-3 text-sm sm:px-4">
      <Link
        className="text-muted-foreground hover:text-foreground"
        to="/settings/personas"
        search={(search) => search}
        hash="personas"
      >
        Personas
      </Link>
      <Link
        className="text-muted-foreground hover:text-foreground"
        to="/settings/personas"
        search={(search) => search}
        hash="crews"
      >
        Crews
      </Link>
      <Link
        className="text-muted-foreground hover:text-foreground"
        to="/settings/personas"
        search={(search) => search}
        hash="playbooks"
      >
        Playbooks
      </Link>
    </nav>
  );
}
