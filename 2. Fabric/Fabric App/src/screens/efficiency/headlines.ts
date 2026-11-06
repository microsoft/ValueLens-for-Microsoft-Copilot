//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { firstHeadline, type Headline, leaderHeadline, MIN_PEOPLE, shareText, totalsBy } from "@/lib/headline";

/** "What goes to Cowork": the Task Breakdown with the most graded sessions. */
export const COWORK_TASK_HEADLINE = leaderHeadline({ label: "Task", value: "Sessions", of: "graded sessions" });

/** "Model usage": the model behind the most sessions, across its cost tiers. */
export const MODEL_USAGE_HEADLINE = leaderHeadline({ label: "Model", value: "Sessions", of: "sessions with a logged model" });

const GOOD_MATCH = "Good match";

/**
 * "Good matches make up 66% of Agents sessions, against 40% of Copilot
 * sessions." The good-match share of each tool, highest against lowest. A
 * tool with fewer than `MIN_PEOPLE` sessions is left out, and two tools
 * that round to the same share say nothing.
 */
const goodMatchByTool: Headline = (table) => {
    const totals = totalsBy(table, "Activity", "Sessions");
    const outcomeAt = table.columns.findIndex((column) => column.name === "Outcome");
    const activityAt = table.columns.findIndex((column) => column.name === "Activity");
    const sessionsAt = table.columns.findIndex((column) => column.name === "Sessions");
    if (outcomeAt < 0 || activityAt < 0 || sessionsAt < 0) return undefined;
    const good = new Map<string, number>();
    for (const row of table.rows) {
        const sessions = row[sessionsAt];
        if (row[outcomeAt] !== GOOD_MATCH || typeof sessions !== "number" || !Number.isFinite(sessions)) continue;
        const activity = String(row[activityAt]);
        good.set(activity, (good.get(activity) ?? 0) + sessions);
    }
    const tools = [...totals]
        .filter(([, total]) => total >= MIN_PEOPLE)
        .map(([activity, total]) => ({ activity, total, good: good.get(activity) ?? 0 }));
    if (tools.length < 2 || tools.some((tool) => tool.good < 0)) return undefined;
    tools.sort((a, b) => b.good / b.total - a.good / a.total);
    const top = tools[0];
    const bottom = tools[tools.length - 1];
    const high = shareText(top.good, top.total);
    if (top.good <= 0 || high === shareText(tools[1].good, tools[1].total)) return undefined;
    const low = shareText(bottom.good, bottom.total);
    return `Good matches make up ${high} of ${top.activity} sessions, against ${low} of ${bottom.activity} sessions. A comparison, not a cause.`;
};

/** "Match by tool": the tools' good-match shares side by side, or the commonest outcome with one tool. */
export const MATCH_BY_TOOL_HEADLINE = firstHeadline(
    goodMatchByTool,
    leaderHeadline({ label: "Outcome", value: "Sessions", of: "sessions" }),
);
