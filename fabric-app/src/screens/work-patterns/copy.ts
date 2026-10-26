//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export const M365_ACTIVITY_TITLE = "Microsoft 365 activity";
export const M365_ACTIVITY_DESCRIPTION =
    "How people spend a working week across Teams, Outlook, SharePoint, OneDrive, Viva Engage and the Office apps.";

export const CONCEALED_FIX =
    'In the Microsoft 365 admin center, go to Settings > Org settings > Reports, untick "Display concealed user, group, and site names in all reports", then run the pipeline again.';

export const NO_APP_USAGE_TITLE = "The report returned no app usage for this period";

export interface EmptyCopy {
    title: string;
    description: string;
}

/**
 * Empty state for the charts built on Microsoft's apps report. When people were active on other
 * workloads, an empty chart means the report itself came back with no app or platform flags, not
 * that nobody worked, so say so rather than "no activity".
 */
export function appReportEmpty(chart: "apps" | "platforms", othersActive: boolean): EmptyCopy {
    if (othersActive) {
        return {
            title: NO_APP_USAGE_TITLE,
            description:
                "People were active on Teams, email, SharePoint or OneDrive, but Microsoft's Microsoft 365 apps report (getM365AppUserDetail) " +
                `had no ${chart === "apps" ? "app" : "platform"} marked for anyone. ` +
                "The per-report row counts are in the m365_report_status table; to compare, open Reports > Usage > Microsoft 365 Apps in the Microsoft 365 admin center.",
        };
    }
    return chart === "apps"
        ? { title: "No app activity", description: "Nobody in the current selection opened a Microsoft 365 app." }
        : { title: "No platform reported", description: "The apps report had no platform for anyone in the current selection." };
}
