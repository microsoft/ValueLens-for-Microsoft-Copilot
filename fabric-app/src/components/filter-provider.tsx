//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FilterContext } from "@/hooks/filter.context";
import { useSemanticModelQuery, useSpeculativeQuery } from "@/hooks/use-semantic-model-query";
import { isConnectionConfigured, isConnectionDeclared } from "@/lib/connections";
import { consumptionOrgAttribute } from "@/lib/filter-profiles";
import { tenantDefaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { runtimeConfig } from "@/lib/runtime-config";
import {
    consumptionFilterOptions,
    consumptionOrgAttributeOptions,
    consumptionOrgValueOptions,
    filterOptions,
    orgAttributeOptions,
    orgValueOptions,
    toConsumptionOrgAttributes,
    toFilterOptions,
    toOrgAttributes,
    toOrgValues,
} from "@/queries/filters";
import { connection, consumptionConnection } from "@/queries/shared";

const optionsConfig = filterOptions();
const attributesConfig = orgAttributeOptions();
const consumptionOptionsConfig = consumptionFilterOptions();
const FALLBACK_ATTRIBUTES = [DEFAULT_ORG_ATTRIBUTE];
const NONE: readonly string[] = [];
/** Consumption Central attributes that name one person each: a filter, not a grouping. */
const PER_PERSON_ATTRIBUTES = new Set(["User", "Manager"]);

function consumptionConfigured(): boolean {
    return isConnectionConfigured(runtimeConfig().semanticModels, consumptionConnection);
}

/** Whether this install reads ValueLens. Without it the filter bar's choices come from Consumption Central. */
function valueLensDeclared(): boolean {
    return isConnectionDeclared(runtimeConfig().semanticModels, connection);
}

const consumptionAttributes = consumptionOrgAttributeOptions();
const NO_QUERY = { connection: consumptionConnection, query: "" };

/** Asks Consumption Central only when the app is connected to it. */
function consumptionAttributesConfig() {
    return consumptionConfigured() ? consumptionAttributes : NO_QUERY;
}

/**
 * Holds the filter bar's state for the whole app and loads its choices once.
 * `applicable` changes with the destination; the state itself does not, so a
 * filter set on one destination is still set on the next.
 *
 * The org attribute is resolved here rather than stored resolved: a choice
 * the model does not have — or the default, on a model whose `Organization`
 * column is empty — falls back to the first column worth grouping by.
 *
 * Every session starts on the tenant's default dates — the last 12 weeks on a
 * large tenant, every date on a small one — which each query works out for
 * itself, so the page's first queries don't wait for the options.
 *
 * Only the filter options load with the page. The org columns load in the
 * background lane, and on screen once a breakdown by org or a filter menu
 * other than the dates asks for them. What only a menu shows — the org
 * values, and Consumption Central's org attributes — loads when one first
 * opens; the attributes also load once an org filter is set.
 *
 * The org values are offered once the org columns have settled which column
 * is in use, so a menu never offers one column's values under another's name.
 * Until then the values of the column in use now load beside them: it seldom
 * changes, so a menu opened early waits for the slower of the two, not both.
 *
 * An install without ValueLens reads the same choices from Consumption
 * Central: its agents and dates, its org attributes and their values.
 */
export function FilterProvider({ applicable, children }: { applicable: readonly FilterKey[]; children: ReactNode }) {
    const fromValueLens = valueLensDeclared();
    // The tenant's default date window from the first query: each query decides in the model whether it narrows.
    const [state, setFilters] = useState<FilterState>(tenantDefaultFilters);
    const [menuOpened, setMenuOpened] = useState(false);
    const [orgColumnsWanted, setOrgColumnsWanted] = useState(false);
    const requestFilterChoices = useCallback(() => setMenuOpened(true), []);
    const requestOrgAttributes = useCallback(() => setOrgColumnsWanted(true), []);
    const { data, error, refetch: retryOptions } = useSemanticModelQuery(
        fromValueLens ? optionsConfig : consumptionOptionsConfig,
    );
    const columnsWanted = menuOpened || orgColumnsWanted;
    const attributesResult = useSemanticModelQuery(
        fromValueLens ? { ...attributesConfig, background: !columnsWanted } : { ...attributesConfig, query: "" },
    );

    const consumptionWanted = menuOpened || state.organizations.length > 0;
    const consumptionResult = useSemanticModelQuery(
        fromValueLens
            ? consumptionWanted
                ? consumptionAttributesConfig()
                : NO_QUERY
            : { ...consumptionAttributesConfig(), background: !columnsWanted },
    );
    const consumptionOrgAttributes = useMemo(() => {
        if (!consumptionConfigured()) return NONE;
        if (consumptionResult.data?.status === "success") return toConsumptionOrgAttributes(consumptionResult.data.table);
        return consumptionResult.data?.status === "error" ? NONE : undefined;
    }, [consumptionResult.data]);

    // Loaded or failed: either way they've settled which column is in use.
    const columnsResult = fromValueLens ? attributesResult : consumptionResult;
    const columnsSettled = columnsResult.data !== undefined || columnsResult.error !== undefined;

    const options = useMemo(() => (data?.status === "success" ? toFilterOptions(data.table) : undefined), [data]);

    const orgAttributes = useMemo(() => {
        const loaded = fromValueLens
            ? attributesResult.data?.status === "success"
                ? toOrgAttributes(attributesResult.data.table)
                : []
            : (consumptionOrgAttributes ?? NONE).filter((attribute) => !PER_PERSON_ATTRIBUTES.has(attribute));
        return loaded.length > 0 ? loaded : FALLBACK_ATTRIBUTES;
    }, [fromValueLens, attributesResult.data, consumptionOrgAttributes]);

    // Consumption Central spells some attributes its own way: "Organization" is its "Organisation".
    const wantedColumn = fromValueLens ? state.orgAttribute : consumptionOrgAttribute(state.orgAttribute);
    const resolvedColumn = orgAttributes.includes(wantedColumn) ? wantedColumn : orgAttributes[0];
    const orgAttribute = useMemo(() => describeOrgAttribute(resolvedColumn), [resolvedColumn]);

    const values = useMemo(
        () => (fromValueLens ? orgValueOptions(orgAttribute) : consumptionOrgValueOptions(consumptionOrgAttribute(resolvedColumn))),
        [fromValueLens, orgAttribute, resolvedColumn],
    );
    const valuesResult = useSemanticModelQuery(menuOpened && columnsSettled ? values : { ...values, query: "" });
    // After the query above, which then joins this one where it waits or reads its answer.
    useSpeculativeQuery(menuOpened && !columnsSettled ? values : { ...values, query: "" });
    // While the values load, those held are the last column's, if any.
    const orgValues = useMemo(
        () =>
            valuesResult.data?.status === "success" && !valuesResult.isLoading
                ? toOrgValues(valuesResult.data.table)
                : undefined,
        [valuesResult.data, valuesResult.isLoading],
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
            retryOptions,
            applicable,
            orgAttribute,
            orgAttributes,
            orgValues,
            consumptionOrgAttributes,
            requestFilterChoices,
            requestOrgAttributes,
        }),
        [
            filters,
            options,
            error,
            retryOptions,
            applicable,
            orgAttribute,
            orgAttributes,
            orgValues,
            consumptionOrgAttributes,
            requestFilterChoices,
            requestOrgAttributes,
        ],
    );

    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
