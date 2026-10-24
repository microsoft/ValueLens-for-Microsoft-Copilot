//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { leaderHeadline } from "@/lib/headline";

/** "Most-used agents": the busiest of the fifteen agents shown. */
export const AGENT_USAGE_HEADLINE = leaderHeadline({
    label: "Agent",
    value: "Sessions",
    of: "sessions across the agents shown",
});
