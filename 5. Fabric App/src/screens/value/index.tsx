//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { SurfacesStage } from "./surfaces-stage";
import { TasksStage } from "./tasks-stage";
import { EstimatedValueStage } from "./estimated-value-stage";

/**
 * What the work was, read top to bottom: how much got done and what kind,
 * where it happened, then what that recorded work would have cost under an
 * explicit rate and effort scenario.
 */
export function ValueScreen() {
    return (
        <div className="flex flex-col gap-800">
            <TasksStage />
            <SurfacesStage />
            <EstimatedValueStage />
        </div>
    );
}
