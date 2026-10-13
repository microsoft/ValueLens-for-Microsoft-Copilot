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
        "[Licensed Utilisation]",
    ],
    topOutcome: ["[Top Value Outcome]"],
    taskBreakdown: ["[Dimension]", "[Category]", "[Tasks]", "[Share]"],
    surfaceUsage: [
        "[Lens]",
        "[Category]",
        "[All Tasks]",
        "[Licensed Tasks]",
        "[Unlicensed Tasks]",
        "[Agent Tasks]",
    ],
    leaderboardSummary: [
        "[All Users]",
        "[All Sessions]",
        "[All Per User]",
        "[All Per Week]",
        "[Licensed Users]",
        "[Licensed Sessions]",
        "[Licensed Per User]",
        "[Licensed Per Week]",
        "[Licence Utilisation]",
        "[Unlicensed Users]",
        "[Unlicensed Sessions]",
        "[Unlicensed Per User]",
        "[Unlicensed Per Week]",
        "[Unlicensed Tasks]",
        "[Agent Users]",
        "[Agent Sessions]",
        "[Agent Per User]",
        "[Agent Per Week]",
        "[Agent Tasks]",
        "[Agent Return Rate]",
        "[Agent With Most Users]",
        "[Top Agent Builder Creator]",
        "[Cowork Users]",
        "[Cowork Sessions]",
        "[Cowork Per User]",
        "[Cowork Per Week]",
        "[Cowork Tasks]",
    ],
    leaderboardPeople: [
        "Chat + Agent Org Data[Organization]",
        "Chat + Agent Interactions (Audit Logs)[Audit_UserId]",
        "[Is Grand Total]",
        "[Is Group Total]",
        "[Active Users]",
        "[Sessions]",
        "[Sessions Per User Per Week]",
    ],
    leaderboardTasks: [
        "Chat + Agent Interactions (Audit Logs)[AppHost]",
        "Chat + Agent Interactions (Audit Logs)[Behavior_Enriched_Full]",
        "[Is Grand Total]",
        "[Is Group Total]",
        "[Active Users]",
        "[Sessions]",
        "[Sessions Per User Per Week]",
    ],
    // The demo tenant has no Cowork sessions, so these were captured by
    // running the same Task Category → Task Breakdown rollup with the Everyone
    // measures; the Cowork query itself was confirmed to run live.
    leaderboardCoworkTasks: [
        "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]",
        "Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]",
        "[Is Grand Total]",
        "[Is Group Total]",
        "[Active Users]",
        "[Sessions]",
        "[Sessions Per User Per Week]",
    ],
} as const;
