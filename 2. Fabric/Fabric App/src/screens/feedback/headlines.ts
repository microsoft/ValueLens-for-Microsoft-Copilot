//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi } from "@/lib/format-kpi";
import { type Headline, leaderHeadline, MIN_PEOPLE, peakHeadline, shareText } from "@/lib/headline";

/** "Weekly feedback sentiment": the week with the most thumbs up and down together. */
export const FEEDBACK_TREND_HEADLINE = peakHeadline({
    date: "Week Start",
    value: "Count",
    of: "feedback items",
    period: "week",
});

/** "What it's about": the category with the most feedback, thumbs up and down together. */
export const FEEDBACK_CATEGORY_HEADLINE = leaderHeadline({ label: "Category", value: "Count", of: "categorised feedback" });

function at(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

/**
 * "Copilot Chat has the highest satisfaction, at 78% across 45 feedback items;
 * Teams has the lowest, at 40%." Only surfaces with at least `MIN_PEOPLE`
 * items are ranked, and two that round to the same top share say nothing.
 */
export const FEEDBACK_SURFACE_HEADLINE: Headline = (table) => {
    const nameAt = at(table, "Surface / Agent");
    const totalAt = at(table, "Total Feedback");
    const satisfactionAt = at(table, "Satisfaction");
    if (nameAt < 0 || totalAt < 0 || satisfactionAt < 0) return undefined;
    const surfaces = table.rows.flatMap((row) => {
        const name = row[nameAt];
        const total = row[totalAt];
        const satisfaction = row[satisfactionAt];
        if (typeof name !== "string" || name === "" || typeof total !== "number" || typeof satisfaction !== "number") return [];
        if (!Number.isFinite(total) || !Number.isFinite(satisfaction) || total < MIN_PEOPLE) return [];
        if (satisfaction < 0 || satisfaction > 1) return [];
        return [{ name, total, satisfaction }];
    });
    if (surfaces.length < 2) return undefined;
    surfaces.sort((a, b) => b.satisfaction - a.satisfaction);
    const top = surfaces[0];
    const bottom = surfaces[surfaces.length - 1];
    const high = shareText(top.satisfaction, 1);
    const low = shareText(bottom.satisfaction, 1);
    if (high === shareText(surfaces[1].satisfaction, 1) || low === shareText(surfaces[surfaces.length - 2].satisfaction, 1)) {
        return undefined;
    }
    return `${top.name} has the highest satisfaction, at ${high} across ${formatKpi(top.total, "whole")} feedback items; ${bottom.name} has the lowest, at ${low}.`;
};
