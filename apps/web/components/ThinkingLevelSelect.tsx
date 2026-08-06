import type { ThinkingLevel } from "@pi-cloud-agent/protocol";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ThinkingLevelSelect({
  levels,
  value,
  onChange,
  disabled = false,
  className,
}: {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const level = levels.find((candidate) => candidate === next);
        if (level) onChange(level);
      }}
      disabled={disabled || levels.length < 2}
    >
      <SelectTrigger aria-label="Thinking level" className={className}>
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
