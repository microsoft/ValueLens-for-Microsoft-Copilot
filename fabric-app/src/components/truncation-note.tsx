//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Info } from "lucide-react";
import { formatKpi } from "@/lib/format-kpi";
import { cn } from "@/lib/utils";

interface TruncationNoteProps {
    /** Rows the list shows. */
    shown: number;
    /** Rows it would show uncapped, from the query's `[Total]`. */
    total: number | undefined;
    /** What the rows are, plural: "people", "agents". */
    noun: string;
    /** How the shown rows were picked, such as "by sessions". */
    by?: string;
    /** Subtotals still cover all leaf rows, including those omitted by the cap. */
    rollup?: boolean;
    className?: string;
}

/**
 * A small "Showing the top 1,000 of 12,345 people" line under a list the
 * query capped. A missing or inconsistent total never implies a whole list.
 */
export function TruncationNote({ shown, total, noun, by, rollup, className }: TruncationNoteProps) {
    if ((shown === 0 && !total) || total === shown) return null;
    const unknown = total === undefined || !Number.isSafeInteger(total) || total < shown;

    return (
        <p
            className={cn(
                "flex items-start gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground",
                className,
            )}
        >
            <Info className="icon-size-200 shrink-0" aria-hidden="true" />
            <span>
                {unknown ? (
                    <>Showing {formatKpi(shown, "whole")} {noun}{by ? ` ${by}` : ""}. The full count is unavailable; this list may be incomplete.</>
                ) : (
                    <>Showing the top {formatKpi(shown, "whole")} of {formatKpi(total, "whole")} {noun}{by ? ` ${by}` : ""}.</>
                )}
                {rollup && " Group totals include everyone in the selection; a person may appear in more than one group."}
            </span>
        </p>
    );
}
