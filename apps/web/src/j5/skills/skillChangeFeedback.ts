/** Explain how a completed skill change reaches an already-running agent. */
export function skillChangeFeedback(message: string): string {
  return `${message} For running agents, use “Restart agent session” in the command palette to pick up these changes.`;
}
