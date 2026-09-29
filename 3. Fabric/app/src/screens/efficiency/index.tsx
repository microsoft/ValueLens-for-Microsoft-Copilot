//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CoworkFitStage } from "./cowork-fit-stage";

/**
 * Whether the right tool is doing the job: the report's Cowork Fit and Model
 * Fit pages. Cowork fit is built; model fit follows.
 */
export function EfficiencyScreen() {
    return (
        <div className="flex flex-col gap-800">
            <CoworkFitStage />
        </div>
    );
}
