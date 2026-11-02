export type PersonaRowAction =
  | "edit"
  | "details"
  | "duplicate"
  | "export"
  | "copy"
  | "remove"
  | "restore";

/**
 * What a Personas settings row offers, in menu order. A removed persona offers only Restore.
 * Details is here only where a tap opens the editor; elsewhere the tap already opens the sheet.
 */
export function personaRowActions(
  persona: { readonly removed: boolean; readonly editable: boolean },
  hasOtherEnvironments: boolean,
): ReadonlyArray<PersonaRowAction> {
  if (persona.removed) return ["restore"];
  return [
    ...(persona.editable ? (["edit", "details"] as const) : []),
    "duplicate",
    "export",
    ...(hasOtherEnvironments ? (["copy"] as const) : []),
    "remove",
  ];
}
