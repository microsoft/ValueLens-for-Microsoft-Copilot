//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { readNumber, type SummaryRow } from "@/lib/summary-row";

export function coworkLimitState(row: SummaryRow | undefined) {
    const allowanceUsed = readNumber(row, "[Allowance Used]");
    const policyHeadroom = readNumber(row, "[Policy Headroom]");
    return {
        allowanceUsed,
        policyHeadroom,
        usersOverLimit: readNumber(row, "[Users Over Limit]") ?? 0,
        noLimitSet: allowanceUsed === undefined && (policyHeadroom === undefined || policyHeadroom < 0),
    };
}
