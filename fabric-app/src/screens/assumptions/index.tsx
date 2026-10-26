//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { TimePerTaskStage } from "./time-per-task-stage";

/**
 * The assumptions behind the app's value figures that an organisation can
 * set for itself: for now, how long each task would take without Copilot.
 * Like the appendix it reads no activity through the filter bar, so no
 * filter applies.
 */
export function AssumptionsScreen() {
    return (
        <div className="flex flex-col gap-800">
            <TimePerTaskStage />
        </div>
    );
}
