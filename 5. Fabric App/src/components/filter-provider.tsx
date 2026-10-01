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
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import {
    filterOptions,
    orgAttributeOptions,
    orgValueOptions,
    toFilterOptions,
    toOrgAttributes,
    toOrgValues,
} from "@/queries/filters";

const optionsConfig = filterOptions();
const attributesConfig = orgAttributeOptions();
const FALLBACK_ATTRIBUTES = [DEFAULT_ORG_ATTRIBUTE];

/**
 * Holds the filter bar's state for the whole app and loads its choices once.
 * `applicable` changes with the destination; the state itself does not, so a
 * filter set on one destination is still set on the next.
 *
 * The org attribute is resolved here rather than stored resolved: a choice
 * the model does not have — or the default, on a model whose `Organization`
 * column is empty — falls back to the first column worth grouping by.
 */
export function FilterProvider({ applicable, children }: { applicable: readonly FilterKey[]; children: ReactNode }) {
    const [state, setFilters] = useState<FilterState>(defaultFilters);
    const { data, error } = useSemanticModelQuery(optionsConfig);
    const attributesResult = useSemanticModelQuery(attributesConfig);

    const options = useMemo(() => (data?.status === "success" ? toFilterOptions(data.table) : undefined), [data]);

    const orgAttributes = useMemo(() => {
        const loaded =
            attributesResult.data?.status === "success" ? toOrgAttributes(attributesResult.data.table) : [];
        return loaded.length > 0 ? loaded : FALLBACK_ATTRIBUTES;
    }, [attributesResult.data]);

    const resolvedColumn = orgAttributes.includes(state.orgAttribute) ? state.orgAttribute : orgAttributes[0];
    const orgAttribute = useMemo(() => describeOrgAttribute(resolvedColumn), [resolvedColumn]);

    const valuesConfig = useMemo(() => orgValueOptions(orgAttribute), [orgAttribute]);
    const valuesResult = useSemanticModelQuery(valuesConfig);
    const orgValues = useMemo(
        () => (valuesResult.data?.status === "success" ? toOrgValues(valuesResult.data.table) : undefined),
        [valuesResult.data],
    );

    const filters = useMemo(
        () => (state.orgAttribute === resolvedColumn ? state : { ...state, orgAttribute: resolvedColumn }),
        [state, resolvedColumn],
    );

    const value = useMemo(
        () => ({
            filters,
            setFilters,
            options,
            optionsError: error,
            applicable,
            orgAttribute,
            orgAttributes,
            orgValues,
        }),
        [filters, options, error, applicable, orgAttribute, orgAttributes, orgValues],
    );

    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
