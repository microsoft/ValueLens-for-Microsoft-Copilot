//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Column names the queries return, as authored. Confirm against the live model after the first M365 load. */
export const liveColumns = {
    m365Status: ["[Rows]", "[People]", "[First Date]", "[Last Date]", "[Concealed Share]"],
    m365Summary: [
        "[People Active]",
        "[Days Loaded]",
        "[First Date]",
        "[Last Date]",
        "[Active Days Per Week]",
        "[Workloads Per Active Day]",
        "[Meetings Per Week]",
        "[Call Hours Per Week]",
        "[Emails Sent Per Week]",
        "[Chats Per Week]",
    ],
    m365WorkloadTrend: ["[Week Start]", "[Workload]", "[People]", "[Share]"],
    m365WorkloadReach: ["[Workload]", "[People]", "[Reach]", "[Days Per Week]"],
    m365Apps: ["[App]", "[People]", "[Reach]"],
    m365CopilotSummary: [
        "[M365 People]",
        "[Copilot People]",
        "[Copilot Reach]",
        "[Not Using]",
        "[Licensed People]",
        "[Licensed Not Using]",
        "[Licensed Idle Share]",
    ],
    m365CopilotIndex: ["[Metric]", "[Copilot Users]", "[Others]", "[Index]"],
    m365ByOrg: [
        "[Organization]",
        "[People Active]",
        "[Copilot Users]",
        "[Copilot Reach]",
        "[Active Days Per Week]",
        "[Meetings Per Week]",
        "[Emails Sent Per Week]",
    ],
} as const;
