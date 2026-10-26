//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { TriangleAlert } from "lucide-react";
import type { DestinationId } from "@/components/destinations";
import { useLoadStatus } from "@/hooks/use-load-status";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import {
    describeFreshness,
    describeLoadIssues,
    PAGE_SOURCES,
    type FreshnessDates,
    type FreshnessSource,
} from "@/lib/freshness";
import { SMALL } from "@/lib/type-scale";

const NONE: readonly FreshnessSource[] = [];

type FreshnessLabelProps =
    /** The sources behind one destination. */
    | { destination: DestinationId; sources?: never; dates?: never }
    /** Any set of sources, as behind a report pack; pass `dates` when they have already been read. */
    | { destination?: never; sources: readonly FreshnessSource[]; dates?: FreshnessDates };

/**
 * How recent each source behind the page is, as one muted line: "Audit log to
 * 7 Oct". Nothing at all until a date arrives, and nothing if none does. A
 * load behind the page that failed or loaded with a warning on the latest
 * pipeline run gets an amber line of its own, with the reason dbo.load_log gives.
 */
export function FreshnessLabel({ destination, sources: given, dates: known }: FreshnessLabelProps) {
    const sources = given ?? PAGE_SOURCES[destination!];
    const read = useSourceFreshness(known ? NONE : sources);
    const text = describeFreshness(sources, known ?? read);
    const issues = describeLoadIssues(sources, useLoadStatus(sources.length > 0));
    const line = text && <span className={`${SMALL} text-muted-foreground`}>Data: {text}</span>;
    if (issues.length === 0) return line || null;
    return (
        <span className="flex flex-col gap-100">
            {line}
            {issues.map((issue) => (
                <span key={issue} className={`flex max-w-[80ch] items-start gap-100 ${SMALL} text-caution`}>
                    <TriangleAlert className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
                    {issue}
                </span>
            ))}
        </span>
    );
}
