"use client";

import type { LlmConnectionSummary } from "@pi-cloud-agent/protocol";
import { ChevronDownIcon, StarIcon, Trash2Icon } from "lucide-react";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

export function LlmConnectionTable({
  connections,
  busyId,
  onMakeDefault,
  onRemove,
}: {
  connections: LlmConnectionSummary[];
  busyId: string | null;
  onMakeDefault: (id: string) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LlmConnectionSummary | null>(null);

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Models</th>
              <th className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => (
              <ConnectionRows
                key={connection.id}
                connection={connection}
                expanded={expandedId === connection.id}
                onToggleExpanded={() =>
                  setExpandedId(expandedId === connection.id ? null : connection.id)
                }
                busy={busyId !== null}
                onMakeDefault={() => onMakeDefault(connection.id)}
                onRequestRemove={() => setRemoving(connection)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={`Delete ${removing?.displayName ?? "connection"}?`}
        description={
          removing?.isDefault
            ? "It will disappear from Settings. Existing sessions switch to another default when resumed."
            : "It will disappear from Settings. Existing sessions switch to the default when resumed."
        }
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={removing !== null && busyId === removing.id}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          void onRemove(removing.id).finally(() => setRemoving(null));
        }}
      />
    </>
  );
}

function ConnectionRows({
  connection,
  expanded,
  onToggleExpanded,
  busy,
  onMakeDefault,
  onRequestRemove,
}: {
  connection: LlmConnectionSummary;
  expanded: boolean;
  onToggleExpanded: () => void;
  busy: boolean;
  onMakeDefault: () => void;
  onRequestRemove: () => void;
}) {
  const singleModel = connection.models.length === 1;
  return (
    <Fragment>
      <tr className={cn(!expanded && "border-b border-border last:border-b-0")}>
        <td className="max-w-56 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-medium">{connection.displayName}</span>
            {connection.isDefault && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                <StarIcon className="size-3 fill-current" />
                Default
              </span>
            )}
          </div>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={connection.baseUrl}
          >
            {connection.baseUrl}
          </p>
          {connection.warning && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {connection.warning}
            </p>
          )}
        </td>
        <td className="max-w-44 px-4 py-3">
          {singleModel ? (
            <span
              className="block truncate font-mono text-xs text-muted-foreground"
              title={connection.model}
            >
              {connection.model}
            </span>
          ) : (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={onToggleExpanded}
              className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
            >
              {connection.models.length} models
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
            </button>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
            {!connection.isDefault && (
              <Button
                type="button"
                onClick={onMakeDefault}
                disabled={busy}
                variant="outline"
                size="sm"
              >
                <StarIcon className="size-3.5" />
                Set default
              </Button>
            )}
            <Button
              type="button"
              onClick={onRequestRemove}
              disabled={busy}
              variant="destructive"
              size="sm"
            >
              <Trash2Icon className="size-3.5" />
              Delete
            </Button>
          </div>
        </td>
      </tr>
      <tr className={cn("bg-muted/40", expanded && "border-b border-border last:border-b-0")}>
        <td colSpan={3} className="p-0">
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              <div className="flex flex-wrap gap-1.5 px-4 py-3">
                {connection.models.map((model) => (
                  <span
                    key={model.id}
                    className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {model.id}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </td>
      </tr>
    </Fragment>
  );
}
