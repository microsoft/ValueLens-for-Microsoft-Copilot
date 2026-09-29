//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { modelFitVerdictsFor } from "./model-fit-verdicts";

/**
 * The table view behind the report's Task bookmark, queried directly so the
 * app does not need to emulate the field parameter.
 */
export function modelFitByTask() {
    return modelFitVerdictsFor(
        "'Chat + Agent Interactions (Audit Logs)'[Task Breakdown Group]",
        "Unclassified task",
    );
}
