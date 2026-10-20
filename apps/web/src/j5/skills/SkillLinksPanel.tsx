import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  SkillDeletePreview,
  SkillLinkPreview,
  SkillLinkRequest,
  ExistingSkillLink,
  SkillLinkInspect,
} from "@t3tools/contracts";
import type { SkillOrigin } from "@t3tools/shared/j5/skillInventory";
import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { skillLinkEnvironment } from "./skillLinkAtoms";
import { skillChangeFeedback } from "./skillChangeFeedback";

function messageOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Unknown request tag: j5.skills.links.")
    ? "This environment's server does not support skill linking yet. Update and restart the app or server hosting this environment, then reconnect."
    : message;
}
export type SkillLinkSelection = {
  readonly source: SkillLinkRequest["source"];
  readonly origin: SkillOrigin;
  readonly action: "link" | "unlink" | "delete";
};
type Props = {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId?: ProjectId;
  readonly projectTitle?: string;
  readonly selection: SkillLinkSelection | null;
  readonly onClose: () => void;
};

export function SkillLinksPanel(props: Props) {
  const canOperate = useAtomValue(skillLinkEnvironment.remove.permissionAtom(props.environmentId));
  const links = useEnvironmentQuery(
    props.connected
      ? skillLinkEnvironment.list({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const remove = useAtomCommand(skillLinkEnvironment.remove, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState("");
  function showResult(message: string) {
    setMessage(message);
    toastManager.add({ type: "info", title: "Skills", description: message });
  }
  async function unlink(id: string, forget = false) {
    if (running.current) return;
    const changesAvailability = links.data?.some(
      (link) => link.id === id && (link.status === "linked" || link.status === "broken"),
    );
    running.current = true;
    setBusy(true);
    try {
      const result = await remove({
        environmentId: props.environmentId,
        input: { id, ...(forget ? { forget: true } : {}) },
      });
      showResult(
        result._tag === "Success"
          ? result.value.action === "removed" && changesAvailability
            ? skillChangeFeedback(result.value.message)
            : result.value.message
          : messageOf(squashAtomCommandFailure(result)),
      );
      links.refresh();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {props.selection && props.selection.action !== "link" ? (
        <UnlinkSkillDialog
          key={JSON.stringify([props.selection, props.projectId])}
          {...props}
          selection={props.selection}
          onUnlinked={(message) => {
            showResult(message);
            links.refresh();
          }}
        />
      ) : props.selection ? (
        <LinkSkillDialog
          key={JSON.stringify([props.selection, props.projectId])}
          {...props}
          selection={props.selection}
          onLinked={(message) => {
            showResult(message);
            links.refresh();
            props.onClose();
          }}
        />
      ) : null}
      <SettingsSection
        title="Managed links"
        headerAction={
          <Button
            variant="ghost"
            size="xs"
            disabled={!props.connected || busy || links.isPending}
            onClick={() => links.refresh()}
          >
            Refresh links
          </Button>
        }
      >
        {message ? (
          <SettingsRow title="Last action" status={<p role="status">{message}</p>} />
        ) : null}
        {links.error ? (
          <SettingsRow
            title="Links unavailable"
            status={
              <p role="alert" className="text-destructive-foreground">
                {messageOf(links.error)}
              </p>
            }
          />
        ) : null}
        {links.data?.map((link) => (
          <SettingsRow
            key={link.id}
            title={link.skillName}
            description={`${props.providers.find((provider) => provider.instanceId === link.targetInstanceId)?.displayName ?? link.targetInstanceId} · ${link.scope === "user" ? "User" : "Project"}`}
            status={
              link.status !== "linked" ? (
                <p className="text-warning">
                  {link.status === "broken"
                    ? "Broken link: source or SKILL.md is unavailable. You can still unlink it."
                    : link.status === "missing"
                      ? "Link is missing. Remove its managed record."
                      : "Destination was changed or replaced. Forget its record without changing any files."}
                </p>
              ) : undefined
            }
            control={
              <Menu>
                <MenuTrigger
                  aria-label={`More actions for ${link.skillName} link`}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={busy || !props.connected || !canOperate}
                    onClick={() => void unlink(link.id, link.status === "changed")}
                  >
                    {link.status === "changed"
                      ? "Forget record"
                      : link.status === "missing"
                        ? "Remove record"
                        : "Remove provider link"}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            }
          >
            <details className="pb-3 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer">Link details</summary>
              <div className="space-y-1 pt-2 break-words">
                <p>Destination: {link.destinationPath}</p>
                <p>Source: {link.sourcePath}</p>
              </div>
            </details>
          </SettingsRow>
        ))}
        {links.isPending && !links.data ? <SettingsRow title="Loading links…" /> : null}
        {links.data?.length === 0 ? (
          <SettingsRow
            title="No managed links yet"
            description="Links created here will appear here."
          />
        ) : null}
      </SettingsSection>
    </>
  );
}

export function LinkSkillDialog(
  props: Props & {
    readonly selection: SkillLinkSelection;
    readonly onLinked: (message: string) => void;
  },
) {
  const destinations = props.providers.filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  const [targetId, setTargetId] = useState(
    () =>
      (
        destinations.find((entry) => entry.instanceId !== props.selection.source.instanceId) ??
        destinations[0]
      )?.instanceId,
  );
  const [scope, setScope] = useState<SkillLinkRequest["scope"]>(
    props.selection.origin === "Project" && props.projectId ? "project" : "user",
  );
  const preview = useAtomCommand(skillLinkEnvironment.preview, { reportFailure: false });
  const create = useAtomCommand(skillLinkEnvironment.create, { reportFailure: false });
  const [result, setResult] = useState<{
    request: SkillLinkRequest;
    preview: SkillLinkPreview;
  } | null>(null);
  const [errorState, setError] = useState<{
    request: SkillLinkRequest | null;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const request = useMemo(
    () =>
      targetId && props.connected
        ? {
            source: props.selection.source,
            targetInstanceId: targetId,
            scope,
            ...(props.projectId ? { projectId: props.projectId } : {}),
          }
        : null,
    [props.selection.source, targetId, scope, props.projectId, props.connected],
  );
  useEffect(() => {
    let active = true;
    if (request && props.connected)
      void preview({ environmentId: props.environmentId, input: request }).then((response) => {
        if (!active) return;
        if (response._tag === "Success") setResult({ request, preview: response.value });
        else setError({ request, message: messageOf(squashAtomCommandFailure(response)) });
      });
    return () => {
      active = false;
    };
  }, [request, props.environmentId, props.connected, preview]);
  const checked = result?.request === request ? result.preview : null;
  const error = errorState?.request === request ? errorState.message : "";
  async function link() {
    if (!request || !checked || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await create({
        environmentId: props.environmentId,
        input: {
          ...request,
          expectedSourcePath: checked.sourcePath,
          expectedDestinationPath: checked.destinationPath,
        },
      });
      if (response._tag === "Success")
        props.onLinked(
          response.value.action === "created"
            ? skillChangeFeedback(response.value.message)
            : response.value.message,
        );
      else {
        setError({ request, message: messageOf(squashAtomCommandFailure(response)) });
        setResult(null);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Make skill available</DialogTitle>
          <DialogDescription>
            Make {props.selection.source.name} available to a provider by linking its source folder.
            Edits to that folder are shared.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <label className="grid gap-2 text-sm">
              Destination provider
              <Select
                value={targetId ?? ""}
                disabled={busy}
                onValueChange={(id) =>
                  setTargetId(
                    destinations.find((provider) => provider.instanceId === id)?.instanceId,
                  )
                }
              >
                <SelectTrigger aria-label="Link destination provider">
                  <SelectValue>
                    {destinations.find((provider) => provider.instanceId === targetId)
                      ?.displayName ??
                      targetId ??
                      "No Codex or Claude instances"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {destinations.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName ?? provider.instanceId} ({provider.instanceId})
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="grid gap-2 text-sm">
              Scope
              <Select
                value={scope}
                disabled={busy}
                onValueChange={(value) => {
                  if (value === "user" || value === "project") setScope(value);
                }}
              >
                <SelectTrigger aria-label="Link scope">
                  <SelectValue>
                    {scope === "user" ? "User" : `Project: ${props.projectTitle}`}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="project" disabled={!props.projectId}>
                    Project: {props.projectTitle ?? "Select a project first"}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </label>
            {checked ? (
              <div className="space-y-2 text-xs break-words">
                <p>
                  <strong>Source folder:</strong> {checked.sourcePath}
                </p>
                <p>
                  <strong>Destination:</strong> {checked.destinationPath}
                </p>
                {checked.sharedWith.length > 1 ? (
                  <p>
                    This destination is shared by{" "}
                    {checked.sharedWith
                      .map((entry) => `${entry.label} (${entry.instanceId})`)
                      .join(", ")}
                    . Linking or unlinking here affects all of them.
                  </p>
                ) : null}
                {checked.warnings.map((warning) => (
                  <p key={warning} className="text-muted-foreground">
                    {warning}
                  </p>
                ))}
                {checked.conflict ? <p role="alert">{checked.conflict}</p> : null}
                {checked.status === "already-linked" ? (
                  <p>
                    The same source is already linked. Continuing leaves it unchanged; existing
                    links created elsewhere remain unmanaged.
                  </p>
                ) : null}
              </div>
            ) : !error ? (
              <p className="text-sm">
                {props.connected ? "Preparing preview…" : "Environment disconnected."}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !props.connected || !checked || checked.status === "conflict"}
            onClick={() => void link()}
          >
            {busy ? "Making available…" : "Make available"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UnlinkSkillDialog(
  props: Props & {
    readonly selection: SkillLinkSelection;
    readonly onUnlinked: (message: string) => void;
  },
) {
  const inspect = useAtomCommand(skillLinkEnvironment.inspect, { reportFailure: false });
  const unlink = useAtomCommand(skillLinkEnvironment.unlink, { reportFailure: false });
  const previewDeletion = useAtomCommand(skillLinkEnvironment.deletePreview, {
    reportFailure: false,
  });
  const deleteSkill = useAtomCommand(skillLinkEnvironment.delete, { reportFailure: false });
  const [deletion, setDeletion] = useState<{
    request: SkillLinkInspect;
    preview: SkillDeletePreview;
  } | null>(null);
  const request = useMemo(
    () =>
      props.connected
        ? {
            source: props.selection.source,
            ...(props.projectId ? { projectId: props.projectId } : {}),
          }
        : null,
    [props.connected, props.selection.source, props.projectId],
  );
  const [inspection, setInspection] = useState<{
    request: SkillLinkInspect;
    options: ReadonlyArray<ExistingSkillLink> | null;
    errors: string[];
  } | null>(null);
  const checkedDeletion = deletion?.request === request ? deletion.preview : null;
  const options = inspection?.request === request ? inspection.options : null;
  const errors = inspection?.request === request ? inspection.errors : [];
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let active = true;
    if (request)
      void inspect({ environmentId: props.environmentId, input: request }).then(async (result) => {
        if (!active) return;
        setInspection({
          request,
          options: result._tag === "Success" ? result.value : null,
          errors: result._tag === "Success" ? [] : [messageOf(squashAtomCommandFailure(result))],
        });
        if (
          props.selection.action === "delete" &&
          result._tag === "Success" &&
          result.value.length === 0
        ) {
          const preview = await previewDeletion({
            environmentId: props.environmentId,
            input: request,
          });
          if (!active) return;
          if (preview._tag === "Success") setDeletion({ request, preview: preview.value });
          else
            setInspection((previous) =>
              previous
                ? { ...previous, errors: [messageOf(squashAtomCommandFailure(preview))] }
                : previous,
            );
        }
      });
    return () => {
      active = false;
    };
  }, [inspect, props.environmentId, props.selection.action, previewDeletion, request]);

  async function remove(selected: ReadonlyArray<ExistingSkillLink>) {
    if (running.current || !request) return;
    running.current = true;
    setBusy(true);
    setInspection((previous) => (previous ? { ...previous, errors: [] } : previous));
    try {
      const result = await unlink({
        environmentId: props.environmentId,
        input: { links: selected.map((option) => option.request) },
      });
      if (result._tag !== "Success") {
        setInspection((previous) =>
          previous
            ? { ...previous, errors: [messageOf(squashAtomCommandFailure(result))] }
            : previous,
        );
        return;
      }
      const removed = new Set(result.value.removedPaths);
      setInspection((previous) =>
        previous
          ? {
              ...previous,
              options:
                previous.options?.filter(
                  (entry) => !removed.has(entry.request.expectedDestinationPath),
                ) ?? null,
              errors: result.value.failed.map((failure) => `${failure.path}: ${failure.message}`),
            }
          : previous,
      );
      const counts = `${removed.size} ${removed.size === 1 ? "link" : "links"} removed. Source files stay in place.${result.value.refreshFailed ? " Discovery refresh failed; retry Refresh." : ""}`;
      const summary = removed.size > 0 ? skillChangeFeedback(counts) : counts;
      setMessage(summary);
      props.onUnlinked(summary);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function prepareDeletion() {
    if (running.current || !request) return;
    running.current = true;
    setBusy(true);
    setInspection((previous) => (previous ? { ...previous, errors: [] } : previous));
    try {
      const result = await previewDeletion({ environmentId: props.environmentId, input: request });
      if (result._tag === "Success") setDeletion({ request, preview: result.value });
      else
        setInspection((previous) =>
          previous
            ? { ...previous, errors: [messageOf(squashAtomCommandFailure(result))] }
            : previous,
        );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function permanentlyDelete() {
    if (running.current || !request || !checkedDeletion) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await deleteSkill({
        environmentId: props.environmentId,
        input: { ...request, ...checkedDeletion },
      });
      if (result._tag === "Success") {
        props.onUnlinked(skillChangeFeedback(result.value.message));
        props.onClose();
      } else {
        setDeletion(null);
        setInspection((previous) =>
          previous
            ? { ...previous, errors: [messageOf(squashAtomCommandFailure(result))] }
            : previous,
        );
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {checkedDeletion || props.selection.action === "delete"
              ? "Delete source folder:"
              : "Remove provider links:"}{" "}
            {props.selection.source.name}
          </DialogTitle>
          <DialogDescription>
            {checkedDeletion
              ? "Permanently delete the original skill and its files."
              : props.selection.action === "delete"
                ? "Remove existing provider links before deleting the source folder. Providers sharing a destination are unlinked together."
                : "Remove a provider link or all links shown here, including links created elsewhere. This keeps the source folder and its files. Providers sharing a destination are unlinked together."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            {checkedDeletion ? (
              <>
                <p role="alert" className="text-sm text-destructive-foreground">
                  This permanently deletes this skill folder and every file inside it from this
                  environment’s machine. This cannot be undone. Other providers linking to this
                  folder will lose access.
                </p>
                <p className="break-all font-mono text-xs">{checkedDeletion.expectedPath}</p>
              </>
            ) : (
              <>
                {options?.map((option) => (
                  <div
                    key={option.request.expectedDestinationPath}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <div className="min-w-0 break-words">
                      <p className="font-medium">{option.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {option.request.expectedDestinationPath}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !props.connected}
                      aria-label={`Remove provider link ${option.label}`}
                      onClick={() => void remove([option])}
                    >
                      Remove provider link
                    </Button>
                  </div>
                ))}
                {!props.connected ? (
                  <p>Environment disconnected.</p>
                ) : options === null && errors.length === 0 ? (
                  <p>Checking existing links…</p>
                ) : options?.length === 0 ? (
                  <div className="grid gap-2">
                    <p>No removable links found.</p>
                    {props.selection.origin === "Personal" ||
                    props.selection.origin === "Project" ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          An original skill folder must be deleted to remove it from the provider.
                        </p>
                        <Button
                          variant="destructive"
                          disabled={busy || !props.connected}
                          onClick={() => void prepareDeletion()}
                        >
                          {busy ? "Checking…" : "Delete source folder…"}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {message ? <p role="status">{message}</p> : null}
              </>
            )}
            {errors.map((error) => (
              <p key={error} role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={checkedDeletion ? () => setDeletion(null) : props.onClose}
          >
            {checkedDeletion ? "Cancel" : "Close"}
          </Button>
          {checkedDeletion ? (
            <Button
              variant="destructive"
              disabled={busy || !props.connected}
              onClick={() => void permanentlyDelete()}
            >
              {busy ? "Deleting…" : "Permanently delete source folder"}
            </Button>
          ) : options && options.length > 1 ? (
            <Button disabled={busy || !props.connected} onClick={() => void remove(options)}>
              {busy ? "Removing links…" : "Remove all shown links"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
