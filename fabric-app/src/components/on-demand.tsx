//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useStageFilter } from "@/hooks/stage-filter.context";
import { cn } from "@/lib/utils";

/** The lists opened this session, so a revisit doesn't ask again. */
const opened = new Set<string>();

interface OnDemandProps {
    /** Stable for the list, such as "leaderboard-ranking". */
    id: string;
    /** The button: "Show the ranking". */
    label: string;
    /** One line on what the list holds. */
    note: string;
    children: ReactNode;
    className?: string;
}

/**
 * Holds back a long list or slow detail on a live page until it is asked for,
 * so the page's headline figures load first. Its queries start only when the
 * children mount. A download or report pack shows the children at once.
 */
export function OnDemand({ id, label, note, children, className }: OnDemandProps) {
    const { deferDetail } = useStageFilter();
    const [open, setOpen] = useState(() => opened.has(id));
    if (!deferDetail || open) return <>{children}</>;

    return (
        <div
            className={cn(
                "flex flex-wrap items-center justify-between gap-300 rounded-xl border border-dashed border-border bg-card px-500 py-400 print:hidden",
                className,
            )}
        >
            <p className="max-w-[68ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">{note}</p>
            <button
                type="button"
                onClick={() => {
                    opened.add(id);
                    setOpen(true);
                }}
                className="inline-flex items-center gap-100 rounded-md border border-border px-300 py-200-nudge text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                {label}
                <ChevronDown className="icon-size-200" aria-hidden="true" />
            </button>
        </div>
    );
}
