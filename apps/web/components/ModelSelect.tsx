import type { LlmConnectionSummary } from "@pi-cloud-agent/protocol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelSelectionValue, parseModelSelection } from "@/lib/model-selection";

export function ModelSelect({
  connections,
  value,
  onChange,
  disabled = false,
  placeholder = "Model",
  ariaLabel = "Model",
  className,
}: {
  connections: LlmConnectionSummary[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const selection = parseModelSelection(value);
  const selected = selection
    ? connections
        .flatMap((connection) => connection.models.map((model) => ({ connection, model })))
        .find(
          (entry) =>
            entry.connection.id === selection.connectionId &&
            entry.model.id === selection.modelId,
        )
    : null;

  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? "")} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder}>{selected?.model.id}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {connections.map((connection) =>
          connection.models.map((model) => (
            <SelectItem
              key={modelSelectionValue(connection.id, model.id)}
              value={modelSelectionValue(connection.id, model.id)}
            >
              {model.id}
            </SelectItem>
          )),
        )}
      </SelectContent>
    </Select>
  );
}
