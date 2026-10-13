//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { firstHeadline, leaderHeadline, peakHeadline } from "@/lib/headline";

/** "How each theme ended": the busiest topic theme. */
export const THEME_HEADLINE = leaderHeadline({ label: "Theme", value: "Conversations", of: "conversations" });

/** "Where answers came from": the most cited of the ten sources shown. */
export const SOURCE_HEADLINE = leaderHeadline({ label: "Source", value: "Citations", of: "the citations shown" });

/** "How each conversation was answered": the commonest way an answer came. */
export const ARCHETYPE_HEADLINE = leaderHeadline({ label: "Archetype", value: "Conversations", of: "conversations" });

/** "How conversations ended": the commonest ending, or the busiest week when there is only one. */
export const WEEKLY_OUTCOME_HEADLINE = firstHeadline(
    leaderHeadline({ label: "Outcome", value: "Conversations", of: "conversations" }),
    peakHeadline({ date: "Week Start", value: "Conversations", of: "conversations", period: "week" }),
);

/** "What went wrong": the commonest of the errors shown, across both who hit them. */
export const ERROR_HEADLINE = leaderHeadline({ label: "Error Code", value: "Errors", of: "the errors shown" });
