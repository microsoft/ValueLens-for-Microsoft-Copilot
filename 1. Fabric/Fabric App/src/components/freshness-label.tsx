//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId } from "@/components/destinations";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { describeFreshness, PAGE_SOURCES, type FreshnessDates, type FreshnessSource } from "@/lib/freshness";
import { SMALL } from "@/lib/type-scale";

const NONE: readonly FreshnessSource[] = [];

type FreshnessLabelProps =
    /** The sources behind one destination. */
    | { destination: DestinationId; sources?: never; dates?: never }
    /** Any set of sources, as behind a report pack; pass `dates` when they have already been read. */
    | { destination?: never; sources: readonly FreshnessSource[]; dates?: FreshnessDates };

/**
 * How recent each source behind the page is, as one muted line: "Audit log to
 * 7 Oct". Nothing at all until a date arrives, and nothing if none does.
 */
export function FreshnessLabel({ destination, sources: given, dates: known }: FreshnessLabelProps) {
    const sources = given ?? PAGE_SOURCES[destination!];
    const read = useSourceFreshness(known ? NONE : sources);
    const text = describeFreshness(sources, known ?? read);
    if (!text) return null;
    return <span className={`${SMALL} text-muted-foreground`}>Data: {text}</span>;
}
