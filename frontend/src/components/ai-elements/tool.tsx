"use client";

import { Badge } from "@/components/shadcn/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  LoaderCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

/**
 * DevDeck addition — a one-line tool row, in place of `ToolHeader`'s card.
 *
 * `ToolHeader` above is upstream's: `p-3`, a wrench glyph, and a pill badge
 * spelling out the status, inside a bordered `Tool` card with `mb-4` under it.
 * That is ~60px of chrome per call, and an agent turn is routinely twenty calls
 * — the transcript became a stack of boxes with the prose pushed off screen.
 *
 * This trades the badge for a single status glyph and the wrench for nothing,
 * and spends the width it recovers on `summary` (the call's own primary
 * argument) so a collapsed row says what it did rather than only which tool did
 * it. Kept as a separate export rather than a `variant` on `ToolHeader` so the
 * upstream component stays byte-comparable against a future vendor refresh.
 *
 * The status still reaches assistive tech, as the trigger's accessible name:
 * `statusLabels` renders `sr-only` beside the glyph, because an icon on its own
 * would leave the button announcing just "Edit".
 */
export type ToolCompactHeaderProps = {
  name: string;
  state: ToolPart["state"];
  summary?: string;
  className?: string;
};

/**
 * `statusIcons` above is upstream's, sized `size-4` and coloured in raw Tailwind
 * scale values (`text-green-600`, `text-yellow-600`) that were picked for a
 * light theme. This is the same set at row scale in DevDeck's own status tokens,
 * so a finished call reads in the same green as a running worktree elsewhere in
 * the app and a failed one in the same red as an error banner.
 *
 * "Running" is the only animated one, and it animates because it is the only
 * state that will change on its own. It is a spinner rather than the pulsing
 * FILLED disc it used to be: at 14px a solid accent-coloured circle was the
 * heaviest mark on the screen — louder than the error glyph — in a column where
 * every other status is a hairline outline, so the one row still in flight read
 * as the one row something had gone wrong on.
 */
const compactStatusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="text-devdeck-wait" />,
  "approval-responded": <CheckCircleIcon className="text-devdeck-accent" />,
  "input-available": (
    <LoaderCircleIcon className="animate-spin text-devdeck-accent" />
  ),
  "input-streaming": <CircleIcon className="text-devdeck-dim-pane" />,
  "output-available": <CheckCircleIcon className="text-devdeck-run" />,
  "output-denied": <XCircleIcon className="text-devdeck-wait" />,
  "output-error": <XCircleIcon className="text-devdeck-err" />,
};

export const ToolCompactHeader = ({
  className,
  name,
  state,
  summary,
  ...props
}: ToolCompactHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-devdeck-raised",
      className
    )}
    {...props}
  >
    <span className="flex size-3.5 flex-none items-center justify-center [&>svg]:size-3.5">
      {compactStatusIcons[state]}
    </span>
    {/* `bash:` — the colon only when something follows it, so a bare row does
        not read as a label with its value missing. It is what turns the row
        from "bash" (which tool) into "bash: ssh -o … dev2" (what the agent is
        actually doing), and the pair is the whole point of the compact row. */}
    <span className="flex-none font-medium text-[13px] text-devdeck-fg">
      {summary ? `${name}:` : name}
    </span>
    <span className="sr-only">{statusLabels[state]}</span>
    {summary ? (
      <span
        title={summary}
        className="min-w-0 truncate font-mono text-[11.5px] text-devdeck-fg-2"
      >
        {summary}
      </span>
    ) : null}
    {/* The chevron trails the text rather than pinning to the right edge, and a
        spacer after it absorbs what is left. Right-aligned, it sat alone in
        several hundred pixels of empty row and read as unrelated to the call it
        belonged to; here it lands next to short summaries and is pushed out to
        the fold only by summaries long enough to need the room. */}
    <ChevronDownIcon className="size-3.5 flex-none text-devdeck-dim-pane transition-transform group-data-[state=open]:rotate-180" />
    <span className="flex-1" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
