//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { SurfacesStage } from "./surfaces-stage";
import { TasksStage } from "./tasks-stage";

/**
 * What the work was, read top to bottom: how much got done and what kind, then
 * where it happened. The report's Task Breakdown page in three queries;
 * Estimated Value follows once it is built.
 */
export function ValueScreen() {
    return (
        <div className="flex flex-col gap-800">
            <TasksStage />
            <SurfacesStage />
        </div>
    );
}
