//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Info } from "lucide-react";
import { useFilterContext } from "@/hooks/filter.context";
import { filterLabel, isFilterActive, type FilterKey } from "@/lib/filters";

function joinLabels(keys: readonly FilterKey[], orgLabel: string): string {
    const labels = keys.map((key) => filterLabel(key, orgLabel));
    if (labels.length <= 1) return labels.join("");
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Says which of the filter bar's active filters a stage leaves out, and why,
 * so a number that doesn't move when a filter changes never looks broken.
 * Renders nothing when none of `ignored` is active on this destination.
 */
export function FilterNote({ ignored, reason }: { ignored: readonly FilterKey[]; reason: string }) {
    const { filters, applicable, orgAttribute } = useFilterContext();
    const skipped = ignored.filter((key) => applicable.includes(key) && isFilterActive(filters, key));
    if (skipped.length === 0) return null;

    return (
        <p className="flex items-start gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
            <Info className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
            <span>
                {joinLabels(skipped, orgAttribute.label)} {skipped.length > 1 ? "filters don't" : "filter doesn't"} apply here: {reason}
            </span>
        </p>
    );
}
