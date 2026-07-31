"use client";

import { CpuIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  placeholder?: string;
  model?: string | null;
  submitLabel?: string;
  submitEnabled?: boolean;
  submitting?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  tools?: React.ReactNode;
  compact?: boolean;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder = "Give Pi a task…",
  model,
  submitLabel = "Send",
  submitEnabled,
  submitting = false,
  disabled = false,
  autoFocus = false,
  tools,
  compact = false,
}: ChatComposerProps) {
  const canSubmit = !disabled && !submitting && (submitEnabled ?? value.trim().length > 0);

  return (
    <PromptInput
      aria-label="Agent message"
      onSubmit={() => {
        if (canSubmit) return onSubmit();
      }}
    >
      <PromptInputTextarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled || submitting}
        autoFocus={autoFocus}
        className={compact ? "min-h-12" : undefined}
      />
      <PromptInputFooter className="flex-wrap">
        <PromptInputTools className="flex-wrap">
          {tools}
          {model && (
            <span className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground">
              <CpuIcon className="size-3.5 shrink-0" />
              <span className="max-w-44 truncate">{model}</span>
            </span>
          )}
        </PromptInputTools>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground/60 sm:inline">
            Enter to send
          </span>
          <PromptInputSubmit
            aria-label={submitLabel}
            disabled={!canSubmit}
            status={submitting ? "submitted" : "ready"}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
