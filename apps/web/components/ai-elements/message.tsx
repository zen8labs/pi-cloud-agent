"use client";

import { code } from "@streamdown/code";
import { ExternalLinkIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { memo, useEffect } from "react";
import { createPortal } from "react-dom";
import { type LinkSafetyModalProps, Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Streamdown's default modal renders inside <a>/<p>; portal it to avoid hydration errors. */
function LinkSafetyModal({ url, isOpen, onClose, onConfirm }: LinkSafetyModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-background/50 backdrop-blur-sm"
        data-streamdown="link-safety-modal"
        onClick={onClose}
        type="button"
      />
      <div
        aria-modal="true"
        className="relative mx-4 flex w-full max-w-md flex-col gap-4 rounded-xl border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <ExternalLinkIcon className="size-5" />
            <span>Open external link?</span>
          </div>
          <p className="text-sm text-muted-foreground">
            You are about to leave this app and visit an external website.
          </p>
        </div>
        <div
          className={cn(
            "break-all rounded-md bg-muted p-3 font-mono text-sm",
            url.length > 100 && "max-h-32 overflow-y-auto",
          )}
        >
          {url}
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            type="button"
          >
            <ExternalLinkIcon className="size-4" />
            Open link
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkSafetyModal {...props} />,
};

type MessageRole = "assistant" | "system" | "user";

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: MessageRole };

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[95%] flex-col gap-2",
        from === "user" ? "is-user ml-auto items-end" : "is-assistant",
        className,
      )}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "min-w-0 max-w-full text-sm leading-7 text-foreground",
        "group-[.is-user]:w-fit group-[.is-user]:rounded-2xl group-[.is-user]:bg-secondary group-[.is-user]:px-3.5 group-[.is-user]:py-2",
        className,
      )}
      {...props}
    />
  );
}

export type MessageResponseProps = React.ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:text-[var(--color-link)] [&_a]:underline-offset-4 [&_code]:font-mono",
        className,
      )}
      linkSafety={linkSafety}
      plugins={{ code }}
      {...props}
    />
  ),
  (previous, next) => previous.children === next.children,
);

MessageResponse.displayName = "MessageResponse";
