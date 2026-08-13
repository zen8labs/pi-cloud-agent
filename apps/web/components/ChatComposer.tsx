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
  submitLabel?: string;
  submitEnabled?: boolean;
  submitting?: boolean;
  disabled?: boolean;
  active?: boolean;
  stopping?: boolean;
  onStop?: () => void | Promise<void>;
  autoFocus?: boolean;
  tools?: React.ReactNode;
  compact?: boolean;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder = "Give Pi a task…",
  submitLabel = "Send",
  submitEnabled,
  submitting = false,
  disabled = false,
  active = false,
  stopping = false,
  onStop,
  autoFocus = false,
  tools,
  compact = false,
}: ChatComposerProps) {
  const canSubmit = !disabled && !submitting && (submitEnabled ?? value.trim().length > 0);
  const stopsActiveRun = active && value.trim().length === 0;

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
        <PromptInputTools className="min-w-0 flex-1">{tools}</PromptInputTools>
        <div className="ml-auto flex shrink-0 items-center">
          <PromptInputSubmit
            aria-label={
              stopsActiveRun ? (stopping ? "Stopping agent" : "Stop agent") : submitLabel
            }
            disabled={stopsActiveRun ? stopping || !onStop : !canSubmit}
            status={stopsActiveRun ? "streaming" : submitting ? "submitted" : "ready"}
            onStop={onStop}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
