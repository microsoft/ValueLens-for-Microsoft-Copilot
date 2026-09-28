//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { LeaderboardStage } from "./leaderboard-stage";
import { SurfacesStage } from "./surfaces-stage";
import { TasksStage } from "./tasks-stage";

/**
 * What people actually do with Copilot, read top to bottom: how much work got
 * done, where it happened, and who did it. Two report pages, sixty-six visuals
 * and four queries.
 */
export function WorkScreen() {
    return (
        <div className="flex flex-col gap-800">
            <TasksStage />
            <SurfacesStage />
            <LeaderboardStage />
        </div>
    );
}
