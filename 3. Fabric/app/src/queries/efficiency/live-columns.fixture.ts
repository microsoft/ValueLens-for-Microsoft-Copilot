//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Column names returned by the live semantic model on 2026-09-29. */
export const liveColumns = {
    modelFitSummary: [
        "[Sessions]",
        "[Logged Share]",
        "[Well-matched Share]",
        "[Over-specified Share]",
        "[Under-specified Share]",
        "[Coverage Notice]",
    ],
    modelUsage: ["[Model]", "[Cost Tier]", "[Tier Sort]", "[Sessions]", "[Usage Share]"],
    modelMatchByTool: ["[Activity]", "[Outcome]", "[Outcome Order]", "[Sessions]", "[Share]"],
    modelFitByTask: [
        "[Segment]",
        "[Main Model]",
        "[Main Reason]",
        "[Sessions]",
        "[Judged Sessions]",
        "[Well-matched Sessions]",
        "[Over-specified Sessions]",
        "[Under-specified Sessions]",
        "[Judged Share]",
    ],
    modelFitByOrganization: [
        "[Segment]",
        "[Main Model]",
        "[Main Reason]",
        "[Sessions]",
        "[Judged Sessions]",
        "[Well-matched Sessions]",
        "[Over-specified Sessions]",
        "[Under-specified Sessions]",
        "[Judged Share]",
    ],
    modelFitByPerson: [
        "[Segment]",
        "[Main Model]",
        "[Main Reason]",
        "[Sessions]",
        "[Judged Sessions]",
        "[Well-matched Sessions]",
        "[Over-specified Sessions]",
        "[Under-specified Sessions]",
        "[Judged Share]",
    ],
} as const;
