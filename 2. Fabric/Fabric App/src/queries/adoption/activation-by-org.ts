//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_WHOLE } from "../shared";
import query from "./activation-by-org.dax?raw";
import spec from "./activation-by-org.json";

const ORGANIZATION_COLUMN = "Chat + Agent Org DataOrganization";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": {
        name: ORGANIZATION_COLUMN,
        displayName: "Organization",
    },
    "[Licensed Active]": { name: "Licensed Active", displayName: "Active licensed users", format: FORMAT_WHOLE },
    "[Licensed Inactive]": { name: "Licensed Inactive", displayName: "Inactive licensed users", format: FORMAT_WHOLE },
    "[Unlicensed Active]": { name: "Unlicensed Active", displayName: "Active unlicensed users", format: FORMAT_WHOLE },
    "[Unlicensed Inactive]": { name: "Unlicensed Inactive", displayName: "Inactive unlicensed users", format: FORMAT_WHOLE },
    "[All Active]": { name: "All Active", displayName: "Active users", format: FORMAT_WHOLE },
    "[All Inactive]": { name: "All Inactive", displayName: "Inactive users", format: FORMAT_WHOLE },
    "[Agent Active]": { name: "Agent Active", displayName: "Users with agent activity", format: FORMAT_WHOLE },
    "[Agent NotUsing]": { name: "Agent NotUsing", displayName: "Not using agents", format: FORMAT_WHOLE },
};

/** The four activation cohorts the report breaks organizations down by. */
export type ActivationCohort = "licensed" | "unlicensed" | "all" | "agents";

const fieldsByCohort: Record<ActivationCohort, { active: string; inactive: string }> = {
    licensed: { active: "Licensed Active", inactive: "Licensed Inactive" },
    unlicensed: { active: "Unlicensed Active", inactive: "Unlicensed Inactive" },
    all: { active: "All Active", inactive: "All Inactive" },
    agents: { active: "Agent Active", inactive: "Agent NotUsing" },
};

interface ActivationByOrgParams {
    /** Which cohort's active/inactive pair to plot. Defaults to `all`. */
    cohort?: ActivationCohort;
}

/**
 * Active versus inactive users per organization, drawn as a diverging bar so
 * the two halves share a baseline. One query serves all four cohorts; the
 * cohort parameter only selects which columns the spec binds to.
 */
export function activationByOrg(params?: ActivationByOrgParams) {
    const { active, inactive } = fieldsByCohort[params?.cohort ?? "all"];

    const vegaLiteSpec = JSON.parse(
        JSON.stringify(spec)
            .replaceAll("__ACTIVE__", active)
            .replaceAll("__INACTIVE__", inactive)
            .replaceAll("__ORG__", ORGANIZATION_COLUMN),
    ) as VisualizationSpec;

    return { connection, query, columnMetadata, vegaLiteSpec };
}
