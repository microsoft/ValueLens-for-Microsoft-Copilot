//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic model, captured from the
 * published `ValueLens - Fabric` model with the Hourly Value and Effort
 * Scenario filters applied.
 */
export const liveColumns = {
    valueSummary: [
        "[Expert Equivalent Hours Per Week]",
        "[AI Assisted Value]",
        "[Projected Annualised Value]",
        "[AI Assisted Value Per Week]",
        "[Currency Symbol]",
    ],
    valueByTaskGroup: [
        "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]",
        "[Expert Equivalent Hours]",
        "[AI Assisted Value]",
        "[Share of Value]",
    ],
    agentValue: [
        "Chat + Agent Interactions (Audit Logs)[AgentName]",
        "[Active Agent Users]",
        "[Observed Agent Sessions]",
        "[Expert Equivalent Hours]",
        "[AI Assisted Value]",
    ],
    organizationValue: [
        "Chat + Agent Org Data[Organization]",
        "[Active Users]",
        "[Expert Equivalent Hours Per Week]",
        "[AI Assisted Value]",
    ],
} as const;
