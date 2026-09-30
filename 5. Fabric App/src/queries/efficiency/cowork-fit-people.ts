//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import {
    DEFAULT_ORG_ATTRIBUTE,
    describeOrgAttribute,
    withOrgAttribute,
    type OrgAttribute,
} from "@/lib/org-attribute";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./cowork-fit-people.dax?raw";

const ORG_COLUMN = "Chat + Agent Org DataOrganization";
const USER_COLUMN = "Chat + Agent Interactions (Audit Logs)Audit_UserId";

/** The grid's first column: the org value on group rows, the person on leaf rows. */
export const PEOPLE_LABEL_COLUMN = "Who";
export const COWORK_PEOPLE_FIELDS = ["People", "Sessions", "Strong", "Fair", "Worth A Look", "Flagged People"] as const;

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Org Data[Organization]": { name: ORG_COLUMN, displayName: "Organization" },
    "Chat + Agent Interactions (Audit Logs)[Audit_UserId]": { name: USER_COLUMN, displayName: "Person" },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Graded sessions", format: FORMAT_WHOLE },
    "[Strong]": { name: "Strong", displayName: "Strong", format: FORMAT_PERCENT },
    "[Fair]": { name: "Fair", displayName: "Fair", format: FORMAT_PERCENT },
    "[Worth A Look]": { name: "Worth A Look", displayName: "Worth a look", format: FORMAT_PERCENT },
    "[Flagged People]": { name: "Flagged People", displayName: "Flagged", format: FORMAT_WHOLE },
};

/**
 * The report's "who" table: each org group, then its people, with their
 * graded Cowork sessions split by grade. People and groups with fewer than
 * five graded sessions are left out, and anyone with half or more of their
 * sessions at Worth a look is flagged for coaching. Pass another org
 * attribute to group by that column instead.
 */
export function coworkFitPeople(attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)) {
    return withOrgAttribute({ connection, query, columnMetadata }, attribute);
}

/** Org rows holding their people; blank org values read as `blankLabel`. */
export function toPeopleTree(table: DataTable, blankLabel: string): RollupTree {
    return toRollupTree(table, {
        group: ORG_COLUMN,
        leaf: USER_COLUMN,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: PEOPLE_LABEL_COLUMN,
        fields: COWORK_PEOPLE_FIELDS,
        blankLabel,
    });
}
