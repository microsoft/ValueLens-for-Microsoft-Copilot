//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Column names returned by the live semantic model on 2026-09-29. */
export const liveColumns = {
    feedbackSummary: ["[Satisfaction]", "[Total Feedback]", "[Thumbs Up]", "[Thumbs Down]", "[Theme Summary]"],
    feedbackTrend: ["[Week Start]", "[Feedback Type]", "[Count]", "[Signed Count]", "[Satisfaction]", "[Total Feedback]"],
    feedbackCategory: ["[Category]", "[Feedback Type]", "[Count]", "[Total Feedback]", "[Satisfaction]"],
    feedbackSurface: ["[Surface / Agent]", "[Total Feedback]", "[Thumbs Up]", "[Thumbs Down]", "[Satisfaction]"],
    feedbackComments: [
        "[Date Submitted]",
        "[Feedback Type]",
        "[Feedback Emoji]",
        "[Category]",
        "[Surface / Agent]",
        "[Comment]",
    ],
} as const;
