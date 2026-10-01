//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./organization-value.dax?raw";

export const ORGANIZATION_COLUMN = "Chat + Agent Org DataOrganization";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": { name: ORGANIZATION_COLUMN, displayName: "Organization" },
    "[Active Users]": { name: "Active Users", displayName: "Active users", format: FORMAT_WHOLE },
    "[Expert Equivalent Hours Per Week]": {
        name: "Expert Equivalent Hours Per Week",
        displayName: "Hours per week",
        format: FORMAT_HOURS,
    },
    "[AI Assisted Value]": { name: "AI Assisted Value", displayName: "Estimated value", format: FORMAT_WHOLE },
};

/**
 * Organization contribution to the estimate, kept as a grid rather than a
 * second bar chart.
 *
 * There are only six organizations in the model; the grid keeps users, weekly
 * hours and value visible together instead of asking the reader to reconcile a
 * duplicate ranked bar with the task-group chart above it.
 */
export function organizationValue() {
    return { connection, query, columnMetadata };
}
