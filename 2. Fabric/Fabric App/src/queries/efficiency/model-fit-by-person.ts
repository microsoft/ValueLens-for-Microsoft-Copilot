//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { modelFitVerdictsFor } from "./model-fit-verdicts";

/**
 * The person table keeps the tenant's own identifiers visible; only the test
 * fixture substitutes pseudonyms.
 */
export function modelFitByPerson() {
    return modelFitVerdictsFor("'Chat + Agent Interactions (Audit Logs)'[Audit_UserId]", "Unattributed user");
}
