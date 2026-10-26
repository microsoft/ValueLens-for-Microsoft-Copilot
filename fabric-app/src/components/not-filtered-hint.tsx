//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Info } from "lucide-react";
import { useFilterContext } from "@/hooks/filter.context";
import { groupNotFiltered, type NotFiltered } from "@/lib/filter-profiles";
import { filterLabel, isFilterInEffect, type FilterKey } from "@/lib/filters";

function joinLabels(keys: readonly FilterKey[], orgLabel: string): string {
    const labels = keys.map((key) => filterLabel(key, orgLabel));
    if (labels.length <= 1) return labels.join("");
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

interface NotFilteredHintProps {
    /** What each query on the card couldn't take, from its result's `notFilteredBy`. */
    from?: readonly (readonly NotFiltered[] | undefined)[];
    /** Filters the card deliberately reads past, with `reason`. */
    ignored?: readonly FilterKey[];
    reason?: string;
}

/**
 * A small "Not filtered by …" line for a card the filter bar can't fully
 * reach: the model has no matching column, or the card is deliberately
 * fixed. Only active filters on this destination are named, and nothing
 * renders when every filter applies.
 */
export function NotFilteredHint({ from = [], ignored = [], reason }: NotFilteredHintProps) {
    const { filters, applicable, orgAttribute, options } = useFilterContext();
    const skipped = ignored.filter((key) => applicable.includes(key) && isFilterInEffect(filters, key, options));
    const groups = groupNotFiltered([...from, reason ? skipped.map((key) => ({ key, reason })) : []]);
    if (groups.length === 0) return null;

    return (
        <ul className="flex flex-col gap-100" aria-label="Filters not applied">
            {groups.map((group) => (
                <li
                    key={group.reason}
                    className="flex items-start gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground"
                >
                    <Info className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
                    <span>
                        Not filtered by {joinLabels(group.keys, orgAttribute.label)}: {group.reason}
                    </span>
                </li>
            ))}
        </ul>
    );
}
