//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic models, captured with
 * `scripts/capture-query-fixture.mjs` against the `ValueLens - Fabric` model
 * and, for credits, `Consumption Central`. The rows sit in `__fixtures__`.
 */
export const liveColumns = {
    executiveSummary: [
        "[Hours]",
        "[Tasks]",
        "[People]",
        "[Weeks]",
        "[Skills Available]",
        "[Licensed Seats]",
        "[Seats In Use]",
        "[Seats In Use Pct]",
        "[Unlicensed Users]",
        "[Habit Month]",
        "[Habitual Pct]",
        "[Power Pct]",
        "[Agent Users]",
        "[Agent Hours]",
        "[Agents In Use]",
        "[Satisfaction]",
        "[Feedback]",
        "[People With Organization]",
    ],
    executiveHoursRange: ["[Hours Conservative]", "[Hours Optimistic]"],
    executiveMonths: [
        "[Month Start]",
        "[Copilot Hours]",
        "[Agent Hours]",
        "[Cowork Hours]",
        "[Hours]",
        "[Tasks]",
        "[Seats In Use Pct]",
        "[Habit Pct]",
        "[Satisfaction]",
        "[Feedback]",
    ],
    executiveDepartments: [
        "Chat + Agent Org Data[Organization]",
        "[Licensed Seats]",
        "[Seats In Use Pct]",
        "[Habit Pct]",
        "[Hours]",
        "[People]",
        "[Hours Per Seat Month]",
    ],
    executiveWorkKinds: [
        "Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]",
        "[Hours]",
        "[Tasks]",
        "[People]",
    ],
    executiveCredits: ["[Month Start]", "[Studio Credits]", "[Cowork Credits]"],
    executiveCreditDates: ["[Last Date]"],
} as const;
