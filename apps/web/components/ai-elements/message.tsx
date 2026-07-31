"use client";

import { code } from "@streamdown/code";
import type { HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

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
        "min-w-0 max-w-full text-[15px] leading-7 text-foreground",
        "group-[.is-user]:w-fit group-[.is-user]:rounded-2xl group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-2.5",
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
      plugins={{ code }}
      {...props}
    />
  ),
  (previous, next) => previous.children === next.children,
);

MessageResponse.displayName = "MessageResponse";
