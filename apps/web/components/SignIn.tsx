import { AsteriskIcon } from "lucide-react";
import { IsoMachine } from "@/components/IsoMachine";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function SignIn() {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="flex flex-col p-8 sm:p-12 lg:p-16">
        <header className="sign-in-rise flex items-center gap-2.5">
          <AsteriskIcon className="size-5" style={{ color: "var(--brand)" }} />
          <span className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            ZEN8LABS AGENT
          </span>
        </header>

        <div
          className="sign-in-rise flex flex-1 flex-col justify-center py-16"
          style={{ animationDelay: "75ms" }}
        >
          <h1 className="max-w-md text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Every task gets its own machine.
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Start, steer, and inspect your Pi agent, each in its own isolated sandbox, from
            first prompt to pull request.
          </p>
          <div className="mt-8">
            <a
              href={api.loginUrl()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-85"
            >
              <GitHubMark />
              Continue with GitHub
            </a>
          </div>
        </div>

        <footer className="sign-in-rise" style={{ animationDelay: "150ms" }}>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            © 2026 ZEN8LABS
          </p>
        </footer>
      </section>

      <aside className="relative min-h-[420px] overflow-hidden border-t border-border bg-muted/40 lg:min-h-0 lg:border-l lg:border-t-0">
        <div
          className="sign-in-rise absolute inset-0 p-10 lg:p-14"
          style={{ animationDelay: "150ms" }}
        >
          <IsoMachine />
        </div>
        <CornerMark className="left-3 top-3" />
        <CornerMark className="right-3 top-3" />
        <CornerMark className="bottom-3 left-3" />
        <CornerMark className="bottom-3 right-3" />
      </aside>
    </div>
  );
}

/** Lucide dropped brand icons, so the button carries the official GitHub mark inline. */
function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Registration mark at each corner of the artwork panel, like a print plate. */
function CornerMark({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={cn("absolute size-3 text-muted-foreground/40", className)}
    >
      <path d="M6 1v10M1 6h10" stroke="currentColor" fill="none" />
    </svg>
  );
}
