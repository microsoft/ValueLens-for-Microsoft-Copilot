//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic model, captured by running
 * each `.dax` file against the published `ValueLens - Fabric` model.
 *
 * The Work queries lean on this harder than Adoption does. Several measures
 * the Power BI report binds to — `AI Tasks per Active User per Week`,
 * `UsersInteractingWithAgents`, `Agent AI Tasks Per User Per Week` — do not
 * exist in the published model at all, and `Agent AI Tasks` no longer matches
 * its definition in the shipped `.pbit`. Every measure used here was confirmed
 * live first; these fixtures are what stops that confirmation going stale.
 */
export const liveColumns = {
    workSummary: [
        "[All Tasks]",
        "[Licensed Tasks]",
        "[Unlicensed Tasks]",
        "[Agent Tasks]",
        "[All Users]",
        "[Licensed Users]",
        "[Unlicensed Users]",
        "[Agent Users]",
        "[All Rate]",
        "[Licensed Rate]",
        "[Unlicensed Rate]",
        "[Agent Rate]",
        "[Top Value Outcome]",
        "[Licensed Utilisation]",
    ],
    taskBreakdown: ["[Dimension]", "[Category]", "[Tasks]", "[Share]"],
    surfaceUsage: [
        "[Lens]",
        "[Category]",
        "[All Tasks]",
        "[Licensed Tasks]",
        "[Unlicensed Tasks]",
        "[Agent Tasks]",
    ],
    userLeaderboard: [
        "Chat + Agent Org Data[Organization]",
        "Chat + Agent Interactions (Audit Logs)[Audit_UserId]",
        "[All Tasks]",
        "[Licensed Tasks]",
        "[Unlicensed Tasks]",
        "[Agent Tasks]",
        "[Active Days]",
    ],
} as const;
