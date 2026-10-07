//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useConsumptionTable } from "@/hooks/use-consumption-query";
import { useHueColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery, type SummaryResult, type TableResult } from "@/hooks/use-table-query";
import { dateBetween } from "@/lib/dax-filters";
import type { FilterKey } from "@/lib/filters";
import { withOrgAttribute } from "@/lib/org-attribute";
import { reportingDateFilter } from "@/queries/consumption";
import {
    executiveCredits,
    executiveDepartments,
    executiveMonths,
    executiveSummary,
    monthLabel,
} from "@/queries/executive";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import { useExecutiveRange, type ExecutiveRangeState } from "./use-executive-range";

/** Copilot Chat and apps, agents, Cowork: each source keeps its colour in both trends. */
const HOURS_HUES = ["--vl-blue", "--vl-amber", "--vl-lavender"] as const;
/** Copilot Studio agents, Cowork. */
const CREDIT_HUES = ["--vl-amber", "--vl-lavender"] as const;
/** The trend sets its own dates: six months to the end of the range. */
const TREND_IGNORES: FilterKey[] = ["dateRange"];
const SKIP = { connection: "", query: "" };

type Source<T extends (...args: never[]) => unknown> = ReturnType<T>;

export interface ExecutiveData {
    range: ExecutiveRangeState;
    summary: SummaryResult;
    /** Each month of the trend, with the rates the cards compare. */
    months: TableResult;
    monthsSource: Source<typeof executiveMonths>;
    /** Credits each month of the trend, whole tenant. */
    credits: TableResult;
    creditsSource: Source<typeof executiveCredits>;
    /** Credits each month of the date range, whole tenant, for the card's total. */
    creditsInRange: TableResult;
    departments: TableResult;
}

/**
 * The queries more than one stage reads, run once for the page. The trend
 * waits for the activity's dates so it never asks for months it then drops.
 */
export function useExecutiveData(): ExecutiveData {
    const range = useExecutiveRange();
    const { window, start, end } = range.range ?? {};
    const org = useOrgAttribute();
    const hoursColors = useHueColors(HOURS_HUES);
    const creditColors = useHueColors(CREDIT_HUES);

    const params = useMemo(
        () => (window ? { months: window.months.map(monthLabel), rangeMonth: window.rangeMonth } : undefined),
        [window],
    );
    const monthsSource = useMemo(() => executiveMonths(params && { ...params, colors: hoursColors }), [params, hoursColors]);
    const creditsSource = useMemo(
        () => executiveCredits(params && { ...params, colors: creditColors }),
        [params, creditColors],
    );

    const summary = useSummaryQuery(executiveSummary());
    const months = useTableQuery(
        window ? monthsSource : { ...monthsSource, ...SKIP },
        window ? [dateBetween("'Calendar'[Date]", window.from, window.to)] : [],
        TREND_IGNORES,
    );

    const totalSource = useMemo(() => executiveCredits(), []);
    const readCredits = CONSUMPTION_CONFIGURED && window && start && end;
    const credits = useConsumptionTable(
        readCredits ? creditsSource : { ...creditsSource, ...SKIP },
        readCredits ? [reportingDateFilter(window.from, window.to)] : [],
    );
    const creditsInRange = useConsumptionTable(
        readCredits ? totalSource : { ...totalSource, ...SKIP },
        readCredits ? [reportingDateFilter(start, end)] : [],
    );

    const departmentsSource = useMemo(() => withOrgAttribute(executiveDepartments(), org), [org]);
    const departments = useTableQuery(departmentsSource);

    return { range, summary, months, monthsSource, credits, creditsSource, creditsInRange, departments };
}
