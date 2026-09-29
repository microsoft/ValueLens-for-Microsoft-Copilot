//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { FilterContext } from "@/hooks/filter.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { filterOptions, toFilterOptions } from "@/queries/filters";

const optionsConfig = filterOptions();

/**
 * Holds the filter bar's state for the whole app and loads its choices once.
 * `applicable` changes with the destination; the state itself does not, so a
 * filter set on one destination is still set on the next.
 */
export function FilterProvider({ applicable, children }: { applicable: readonly FilterKey[]; children: ReactNode }) {
    const [filters, setFilters] = useState<FilterState>(defaultFilters);
    const { data, error } = useSemanticModelQuery(optionsConfig);

    const options = useMemo(() => (data?.status === "success" ? toFilterOptions(data.table) : undefined), [data]);

    const value = useMemo(
        () => ({ filters, setFilters, options, optionsError: error, applicable }),
        [filters, options, error, applicable],
    );

    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
