//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic model, captured from
 * `npx fabric-app-data query vl --file <query>.dax` against the
 * `ValueLens - Fabric` model.
 *
 * These exist so the query modules fail loudly if a measure is renamed. The
 * published model already diverges from the shipped `.pbit` — it carries 198
 * measures against the template's 176, with `Net ROI` and
 * `Expert Equivalent Hours` renamed — so drift between a customer's model and
 * this app is the expected failure mode, not an edge case.
 */
export const liveColumns = {
    activationSummary: [
        "[Licensed Active]",
        "[Licensed Inactive]",
        "[Licensed Total]",
        "[Licensed Active Pct]",
        "[Unlicensed Active]",
        "[Unlicensed Inactive]",
        "[Unlicensed Total]",
        "[Unlicensed Active Pct]",
        "[All Active]",
        "[All Inactive]",
        "[All Total]",
        "[All Active Pct]",
        "[Agent Active]",
        "[Agent NotUsing]",
        "[Agent Active Pct]",
        "[Headline Overall]",
        "[Headline Licensed]",
        "[Headline Unlicensed]",
        "[Headline Agents]",
    ],
    activationByOrg: [
        "Chat + Agent Org Data[Organization]",
        "[Licensed Active]",
        "[Licensed Inactive]",
        "[Unlicensed Active]",
        "[Unlicensed Inactive]",
        "[All Active]",
        "[All Inactive]",
        "[Agent Active]",
        "[Agent NotUsing]",
    ],
    adoptionSummary: [
        "[Overall Users]",
        "[Overall Sessions]",
        "[Overall SPUW]",
        "[Overall Hours Wk]",
        "[Overall Top Outcome]",
        "[Licensed Users]",
        "[Licensed SPUW]",
        "[Unlicensed Users]",
        "[Unlicensed SPUW]",
        "[Agent Users]",
        "[Agent SPUW]",
        "[Agent Return Rate]",
        "[Cowork Users]",
        "[Cowork SPUW]",
        "[Cowork Hours Wk]",
        "[Cowork Top Outcome]",
    ],
    adoptionTrend: [
        "Chat + Agent Interactions (Audit Logs)[WeekStart]",
        "[Licensed]",
        "[Unlicensed]",
        "[Agents]",
        "[All Sessions]",
        "[Hours]",
    ],
    habitSummary: [
        "[Power]",
        "[Power Pct]",
        "[Habitual]",
        "[Habitual Pct]",
        "[Developing]",
        "[Developing Pct]",
        "[Beginner]",
        "[Beginner Pct]",
        "[Inactive]",
        "[Inactive Pct]",
    ],
    habitTrend: [
        "Chat + Agent Interactions (Audit Logs)[MonthStart]",
        "Stage Legend[Stage]",
        "[Users]",
    ],
} as const;
