"use client";

import { useEffect, useRef } from "react";

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  model?: string | null;
  submitLabel?: string;
  submitting?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder = "Write a message…",
  model,
  submitLabel = "Send",
  submitting = false,
  disabled = false,
  autoFocus = false,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Re-measure whenever the text changes. `value` is the trigger rather than a
  // value the effect reads, which is exactly what the dependency is for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the trigger
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSubmit = !disabled && !submitting && value.trim().length > 0;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

  return (
    <div className="composer-shell">
      <div
        className={`composer-box ${disabled ? "composer-box--disabled" : ""}`}
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line-strong)" }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled || submitting}
          placeholder={placeholder}
          className="composer-input"
          style={{ color: "var(--color-ink)", caretColor: "var(--color-accent)" }}
        />
        <div className="composer-toolbar">
          <span className="composer-hint">
            {submitting ? "running…" : model ? model : "shift+enter for newline"}
          </span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="composer-send"
            aria-label={submitLabel}
          >
            {submitting ? <span className="font-mono text-[10px]">…</span> : <SendIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M8 12V4M8 4L4.5 7.5M8 4l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
