//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { wrapEvaluateBodies } from "@/lib/dax-filters";
import { TREND_MONTHS } from "@/lib/month-over-month";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./executive-months.dax?raw";
import spec from "./executive-hours.json";
import { shapeMonthlyTrend, type MonthlyTrendParams } from "./monthly-trend";

const columnMetadata: ColumnMetadataMap = {
    "[Month Start]": { name: "Month Start", displayName: "Month", format: "mmm yyyy" },
    "[Copilot Hours]": { name: "Copilot Hours", displayName: "Copilot Chat and apps", format: FORMAT_HOURS },
    "[Agent Hours]": { name: "Agent Hours", displayName: "Agents", format: FORMAT_HOURS },
    "[Cowork Hours]": { name: "Cowork Hours", displayName: "Cowork", format: FORMAT_HOURS },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Tasks]": { name: "Tasks", displayName: "Tasks delivered", format: FORMAT_WHOLE },
    "[Seats In Use Pct]": { name: "Seats In Use Pct", displayName: "Licensed seats in use", format: FORMAT_PERCENT },
    "[Habit Pct]": { name: "Habit Pct", displayName: "Habit rate", format: FORMAT_PERCENT },
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
    "[Feedback]": { name: "Feedback", displayName: "Ratings", format: FORMAT_WHOLE },
};

/**
 * Each month's work and the rates the bottom-line cards compare, for the
 * months the caller's date filter covers. The chart stacks expert-equivalent
 * hours by where the work happened: Copilot Chat and apps, agents, Cowork.
 *
 * A month's habit rate is blank until the month is over.
 */
export function executiveMonths(params?: MonthlyTrendParams) {
    return { connection, query, columnMetadata, vegaLiteSpec: shapeMonthlyTrend(spec, params) };
}

// The filter options' last date is the latest activity in the model, read past every filter, and the
// trend with no date filter covers the six months to it: `trendWindow` from that date.
const recentQuery = wrapEvaluateBodies(
    query,
    (body) => `
// With no date filter, the trend covers the ${TREND_MONTHS} months to the last day of activity.
VAR _trendEnd = CALCULATE(MAX('Chat + Agent Interactions (Audit Logs)'[ActivityDate]), REMOVEFILTERS())
VAR _trendFrom = EOMONTH(_trendEnd, -${TREND_MONTHS}) + 1
RETURN
    CALCULATETABLE(
${body}
,
        FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= _trendFrom && 'Calendar'[Date] <= _trendEnd)
    )
`,
);

/**
 * {@link executiveMonths} when no date filter is set. The query finds the
 * last day of activity itself, as the filter options do, so it needn't wait
 * for them: the page asks it with its first queries.
 */
export function executiveRecentMonths(params?: MonthlyTrendParams) {
    return { ...executiveMonths(params), query: recentQuery };
}
