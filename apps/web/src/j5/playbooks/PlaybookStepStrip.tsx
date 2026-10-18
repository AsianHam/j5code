import type { presentPlaybook } from "@t3tools/client-runtime/j5/playbooks";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

const stepColor = {
  current: "bg-primary",
  last: "bg-muted-foreground/60",
  earlier: "bg-primary/35",
  later: "bg-muted",
  available: "bg-muted",
};

export function PlaybookStepStrip({
  steps,
}: {
  steps: ReturnType<typeof presentPlaybook>["steps"];
}) {
  if (steps.length === 0) return null;
  return (
    <Tooltip<string>>
      {({ payload }) => (
        <>
          <ol
            className="relative z-10 grid min-w-0 auto-cols-fr grid-flow-col gap-px"
            aria-label="Playbook steps"
          >
            {steps.map((step, index) => {
              const description = `${index + 1}. ${step.title} · ${step.label}`;
              return (
                <li
                  key={step.id}
                  className="min-w-0"
                  aria-current={step.current ? "step" : undefined}
                >
                  <TooltipTrigger
                    payload={description}
                    render={
                      <span
                        tabIndex={0}
                        className="flex h-6 items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <span className={`block h-2 w-full rounded-sm ${stepColor[step.state]}`} />
                    <span className="sr-only">{description}</span>
                  </TooltipTrigger>
                </li>
              );
            })}
          </ol>
          <TooltipPopup>{payload}</TooltipPopup>
        </>
      )}
    </Tooltip>
  );
}
