//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { AgentRegistryStage } from "./agent-registry-stage";
import { LeaderboardStage } from "./leaderboard-stage";

/**
 * Who is doing the most, read top to bottom: the people, then the agents.
 * The report's Leaderboard and Agent Registry pages.
 */
export function LeaderboardsScreen() {
    return (
        <div className="flex flex-col gap-800">
            <LeaderboardStage />
            <AgentRegistryStage />
        </div>
    );
}
