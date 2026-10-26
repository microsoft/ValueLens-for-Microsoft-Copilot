//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useFilterContext, useOrgAttribute } from "@/hooks/filter.context";
import { useStageFilter } from "@/hooks/stage-filter.context";
import { useConsumptionTableParts } from "@/hooks/use-consumption-query";
import { useHueColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery, type SummaryResult, type TableResult } from "@/hooks/use-table-query";
import { dateBetween } from "@/lib/dax-filters";
import { isTenantDefaultRange, type FilterKey } from "@/lib/filters";
import { withOrgAttribute } from "@/lib/org-attribute";
import {
    CREDIT_PARTS,
    executiveCreditParts,
    executiveCredits,
    executiveDepartments,
    executiveHoursRange,
    executiveMonths,
    executiveRecentMonths,
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
/** The trend with no date filter, which finds its own six months. */
const RECENT_MONTHS = executiveRecentMonths().query;

type Source<T extends (...args: never[]) => unknown> = ReturnType<T>;

export interface ExecutiveData {
    range: ExecutiveRangeState;
    summary: SummaryResult;
    /** The Conservative to Optimistic range under the summary's hours, asked beside it. */
    hoursRange: SummaryResult;
    /** Each month of the trend, with the rates the cards compare. */
    months: TableResult;
    monthsSource: Source<typeof executiveMonths>;
    /** Credits each month of the trend; an org filter can't narrow Copilot Studio's tenant billing. */
    credits: TableResult;
    creditsSource: Source<typeof executiveCredits>;
    /** Credits each month of the date range, for the card's total. */
    creditsInRange: TableResult;
    departments: TableResult;
}

/**
 * The queries more than one stage reads, run once for the page, and only for
 * the stages on show. The summary and the trend are the slowest queries the
 * page waits on, so they ask ahead of the other queries waiting. Neither waits
 * for the task times saved in the app: each is asked at the model's own
 * minutes from the page's first query, and asked again only if the saved
 * times differ. The bottom line's hours range is its own query, asked beside
 * the summary in the same way, so the summary's figures don't wait for it.
 * With no date filter the trend finds its own six months, so it doesn't wait
 * for the activity's dates either; with one, it waits for them so it never
 * asks for months it then drops. Either way it shows nothing until the dates
 * are known, as the cards and the chart read it by them. The credits wait for
 * the dates too, and ask for the trend's months and the date range in one
 * query.
 */
export function useExecutiveData(): ExecutiveData {
    const range = useExecutiveRange();
    const { window, start, end } = range.range ?? {};
    // The tenant's default window ends on the last day with activity, so the trend's own six months are the same.
    const { dateRange } = useFilterContext().filters;
    const dated = dateRange !== undefined && !isTenantDefaultRange(dateRange);
    const { show } = useStageFilter();
    const byOrg = show("where-it-is-landing") || show("what-needs-attention");
    // Only a breakdown by organization needs the column the organizations are in before the filter menu does.
    const org = useOrgAttribute(byOrg);
    const hoursColors = useHueColors(HOURS_HUES);
    const creditColors = useHueColors(CREDIT_HUES);
    const showTrend = show("the-bottom-line") || show("is-it-growing");
    const trend = window && showTrend;

    const params = useMemo(
        () => (window ? { months: window.months.map(monthLabel), rangeMonth: window.rangeMonth } : undefined),
        [window],
    );
    const monthsSource = useMemo(() => executiveMonths(params && { ...params, colors: hoursColors }), [params, hoursColors]);
    const creditsSource = useMemo(
        () => executiveCredits(params && { ...params, colors: creditColors }),
        [params, creditColors],
    );

    const summary = useSummaryQuery({ ...executiveSummary(), lead: true, speculate: true });
    const hoursRange = useSummaryQuery(
        show("the-bottom-line") ? { ...executiveHoursRange(), lead: true, speculate: true } : { ...executiveHoursRange(), ...SKIP },
    );
    const asked = useTableQuery(
        showTrend && !dated
            ? { ...monthsSource, query: RECENT_MONTHS, lead: true, speculate: true }
            : trend
              ? { ...monthsSource, lead: true, speculate: true }
              : { ...monthsSource, ...SKIP },
        dated && trend ? [dateBetween("'Calendar'[Date]", window.from, window.to)] : [],
        TREND_IGNORES,
    );
    const months: TableResult = window ? asked : { ...asked, table: undefined, error: undefined, isLoading: true };

    const readCredits = CONSUMPTION_CONFIGURED && trend && start && end;
    const creditsQuery = useMemo(
        () => (readCredits ? executiveCreditParts({ trend: window, range: { from: start, to: end } }).query : ""),
        [readCredits, window, start, end],
    );
    const { trend: credits, range: creditsInRange } = useConsumptionTableParts(
        readCredits ? { ...creditsSource, query: creditsQuery } : { ...creditsSource, ...SKIP },
        CREDIT_PARTS,
        [],
        TREND_IGNORES,
    );

    const departmentsSource = useMemo(() => withOrgAttribute(executiveDepartments(), org), [org]);
    const departments = useTableQuery(byOrg ? departmentsSource : { ...departmentsSource, ...SKIP });

    return { range, summary, hoursRange, months, monthsSource, credits, creditsSource, creditsInRange, departments };
}
