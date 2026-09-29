//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { modelFitVerdictsFor } from "./model-fit-verdicts";

/**
 * The organization table from Model Fit, bound straight to the org mapping
 * table so destination filters keep behaving like slicers.
 */
export function modelFitByOrganization() {
    return modelFitVerdictsFor("'Chat + Agent Org Data'[Organization]", "Unassigned organization");
}
