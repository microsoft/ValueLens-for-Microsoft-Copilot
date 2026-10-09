//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId } from "@/components/destinations";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { describeFreshness, PAGE_SOURCES } from "@/lib/freshness";
import { SMALL } from "@/lib/type-scale";

/**
 * How recent each source behind the page is, as one muted line: "Audit log to
 * 7 Oct". Nothing at all until a date arrives, and nothing if none does.
 */
export function FreshnessLabel({ destination }: { destination: DestinationId }) {
    const sources = PAGE_SOURCES[destination];
    const dates = useSourceFreshness(sources);
    const text = describeFreshness(sources, dates);
    if (!text) return null;
    return <span className={`${SMALL} text-muted-foreground`}>Data: {text}</span>;
}
