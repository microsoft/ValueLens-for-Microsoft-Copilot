//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describeOrgAttribute, DEFAULT_ORG_ATTRIBUTE, orgColumnRef, type OrgAttribute } from "@/lib/org-attribute";
import { modelFitVerdictsFor } from "./model-fit-verdicts";

/**
 * The organization table from Model Fit, bound straight to the org mapping
 * table so destination filters keep behaving like slicers. Pass another org
 * attribute to group by that column instead.
 */
export function modelFitByOrganization(attribute: OrgAttribute = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)) {
    return modelFitVerdictsFor(orgColumnRef(attribute.column), `Unassigned ${attribute.noun}`);
}
