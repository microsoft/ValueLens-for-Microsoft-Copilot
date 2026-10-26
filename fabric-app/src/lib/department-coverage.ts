//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { DEFAULT_ORG_ATTRIBUTE, type OrgAttribute } from "./org-attribute";

// The app has no count of the people with a department: the summary's
// `[People With Organization]` counts everyone once any org data is loaded. The
// installer's data check gives the real count, so the app only gives the advice,
// worded to hold whatever the coverage.

/** How to fill the gaps. The default org column comes from each person's Department in Microsoft Entra ID. */
export const DEPARTMENT_ADVICE =
    "Views by department leave out everyone without one. To include them, fill in Department on users in Microsoft Entra ID.";

const WHERE_DEPARTMENT_COMES_FROM =
    "The organization comes from each person's Department in Microsoft Entra ID. If it's blank for most people, fill it in there.";

/** The advice for views by the chosen org attribute. Only the default column's source is known, so another gets `undefined`. */
export function departmentAdvice(org: OrgAttribute): string | undefined {
    return org.column === DEFAULT_ORG_ATTRIBUTE ? DEPARTMENT_ADVICE : undefined;
}

/**
 * An empty "No organizations to compare" description that says why it may be
 * empty: where the department comes from, and to fill it in there.
 */
export function orgEmptyDescription(base: string, org: OrgAttribute): string {
    return org.column === DEFAULT_ORG_ATTRIBUTE ? `${base} ${WHERE_DEPARTMENT_COMES_FROM}` : base;
}
