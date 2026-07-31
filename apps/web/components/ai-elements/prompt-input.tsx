"use client";

import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps, FormEvent, HTMLAttributes, KeyboardEvent } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * The focused subset of AI Elements' Prompt Input used by this product.
 * Attachments, screenshots, model menus, and commands stay opt-in until the
 * controller protocol supports them; the form and status semantics stay
 * aligned with the streaming states consumed by the app.
 */
type PromptInputMessage = { text: string };
type PromptInputStatus = "error" | "ready" | "streaming" | "submitted";

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export function PromptInput({ className, onSubmit, children, ...props }: PromptInputProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onSubmit({ text: String(data.get("message") ?? "") }, event);
  };

  return (
    <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
      <InputGroup className="min-h-28 overflow-hidden rounded-2xl border-border bg-background shadow-[0_12px_40px_rgba(0,0,0,0.08)] transition-shadow focus-within:shadow-[0_16px_48px_rgba(0,0,0,0.12)]">
        {children}
      </InputGroup>
    </form>
  );
}

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export function PromptInputTextarea({
  className,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    const submit =
      event.currentTarget.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit?.disabled) event.currentTarget.form?.requestSubmit();
  };

  return (
    <InputGroupTextarea
      className={cn(
        "max-h-52 min-h-16 px-4 pt-4 text-[15px] leading-6 placeholder:text-muted-foreground/70",
        className,
      )}
      name="message"
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

export type PromptInputFooterProps = ComponentProps<typeof InputGroupAddon>;

export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn("justify-between gap-2 border-0 px-3 pb-3", className)}
      {...props}
    />
  );
}

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputTools({ className, ...props }: PromptInputToolsProps) {
  return <div className={cn("flex min-w-0 items-center gap-1.5", className)} {...props} />;
}

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus;
  onStop?: () => void;
};

export function PromptInputSubmit({
  className,
  status = "ready",
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) {
  const generating = status === "submitted" || status === "streaming";
  const handleClick: NonNullable<ComponentProps<typeof InputGroupButton>["onClick"]> = (
    event,
  ) => {
    if (generating && onStop) {
      event.preventDefault();
      onStop();
      return;
    }
    onClick?.(event);
  };

  const icon =
    status === "submitted" ? (
      <Spinner />
    ) : status === "streaming" ? (
      <SquareIcon />
    ) : status === "error" ? (
      <XIcon />
    ) : (
      <ArrowUpIcon />
    );

  return (
    <InputGroupButton
      aria-label={generating ? "Stop" : "Submit"}
      className={cn("size-8 rounded-full", className)}
      onClick={handleClick}
      size="icon-sm"
      type={generating && onStop ? "button" : "submit"}
      variant="default"
      {...props}
    >
      {children ?? icon}
    </InputGroupButton>
  );
}
