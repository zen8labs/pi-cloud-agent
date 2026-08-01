"use client";

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
      <PromptInputFooter>
        <PromptInputTools className="min-w-0 flex-1">
          {tools}
          {model && (
            <span className="max-w-40 shrink truncate rounded-md px-1.5 py-1 text-[11px] text-muted-foreground/80">
              {model}
            </span>
          )}
        </PromptInputTools>
        <div className="ml-auto flex shrink-0 items-center">
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
