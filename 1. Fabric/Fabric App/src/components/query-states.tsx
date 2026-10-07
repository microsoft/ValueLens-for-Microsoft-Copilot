//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cn } from "@/lib/utils";
import { isMissingFromModelError, parseMissingModelObject } from "@/lib/model-errors";

interface QueryStateProps {
    className?: string;
}

/** Placeholder shown while a query is in flight. */
export function QueryLoading({ className }: QueryStateProps) {
    return (
        <div
            role="status"
            aria-live="polite"
            className={cn("flex min-h-[160px] flex-col justify-end gap-300 rounded-xl border border-border bg-card p-500", className)}
        >
            <span className="sr-only">Loading</span>
            <div className="h-200 w-1/3 animate-pulse rounded-sm bg-muted" aria-hidden="true" />
            <div className="h-600 w-2/3 animate-pulse rounded-sm bg-muted" aria-hidden="true" />
            <div className="h-100 w-full animate-pulse rounded-sm bg-muted" aria-hidden="true" />
        </div>
    );
}

interface QueryEmptyProps extends QueryStateProps {
    title: string;
    /** Why there is nothing to show, and what would make data appear. */
    description: string;
}

/** Shown when a query succeeds but the tenant has no data for it. */
export function QueryEmpty({ title, description, className }: QueryEmptyProps) {
    return (
        <div
            className={cn(
                "flex min-h-[160px] flex-col justify-center gap-200 rounded-xl border border-dashed border-border bg-card p-500",
                className,
            )}
        >
            <span className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">{title}</span>
            <p className="max-w-[60ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                {description}
            </p>
        </div>
    );
}

interface QueryErrorProps extends QueryStateProps {
    /** The message returned by the semantic model. */
    message: string;
    onRetry?: () => void;
}

interface ModelUpdateRequiredProps extends QueryStateProps {
    /** Missing columns, tables or measures the app needs. */
    missing: readonly string[];
    /** The raw engine error, when this came from a failed page query. */
    detail?: string;
    onRetry?: () => void;
}

function missingFromMessage(message: string): string[] {
    const missing = parseMissingModelObject(message);
    if (missing?.kind === "column") return [`${missing.table ? `${missing.table}` : "Model"}[${missing.name}]`];
    if (missing?.kind === "table") return [`${missing.name} table`];
    if (missing?.kind === "measure") return [`[${missing.name}]`];
    return [];
}

/** Shown when this app is newer than the semantic model it is reading. */
export function ModelUpdateRequired({ missing, detail, onRetry, className }: ModelUpdateRequiredProps) {
    return (
        <div
            role="alert"
            className={cn(
                "flex min-h-[160px] flex-col justify-center gap-300 rounded-xl border border-caution/50 bg-card p-500",
                className,
            )}
        >
            <span className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                Update your install
            </span>
            <p className="max-w-[68ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                The semantic model is older than this app. Run{" "}
                <code className="font-mono">AnalyticsHubInstaller.exe update</code> (or{" "}
                <code className="font-mono">npx valuelens-install update</code>), then run the loads or refresh again and
                reopen the app.
            </p>
            {missing.length > 0 && (
                <div className="text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    <span className="font-semibold text-foreground">Missing from the model:</span>{" "}
                    <span>{missing.join(", ")}</span>
                </div>
            )}
            {detail && (
                <p className="max-w-[68ch] font-monospace text-[length:var(--text-200)] leading-300 text-muted-foreground">
                    {detail}
                </p>
            )}
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="self-start rounded-md border border-border px-300 py-200-nudge text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                    Try again
                </button>
            )}
        </div>
    );
}

/** Shown when the semantic model rejects the query or is unreachable. */
export function QueryError({ message, onRetry, className }: QueryErrorProps) {
    if (isMissingFromModelError(message)) {
        return <ModelUpdateRequired className={className} missing={missingFromMessage(message)} detail={message} onRetry={onRetry} />;
    }

    return (
        <div
            role="alert"
            className={cn(
                "flex min-h-[160px] flex-col justify-center gap-300 rounded-xl border border-destructive/40 bg-card p-500",
                className,
            )}
        >
            <span className="text-[length:var(--text-400)] leading-400 font-semibold text-destructive">
                This didn't load
            </span>
            <p className="max-w-[60ch] font-monospace text-[length:var(--text-200)] leading-300 text-muted-foreground">
                {message}
            </p>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="self-start rounded-md border border-border px-300 py-200-nudge text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                    Try again
                </button>
            )}
        </div>
    );
}
