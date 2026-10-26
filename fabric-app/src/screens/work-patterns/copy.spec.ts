//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { appReportEmpty, NO_APP_USAGE_TITLE } from "./copy";

describe("appReportEmpty", () => {
    it("blames the apps report, not the people, when others were active", () => {
        for (const chart of ["apps", "platforms"] as const) {
            const copy = appReportEmpty(chart, true);
            expect(copy.title).toBe("The report returned no app usage for this period");
            expect(copy.title).toBe(NO_APP_USAGE_TITLE);
            expect(copy.description).toContain("getM365AppUserDetail");
            expect(copy.description).toContain("m365_report_status");
            expect(copy.description).not.toMatch(/nobody/i);
        }
        expect(appReportEmpty("platforms", true).description).toContain("no platform marked");
    });

    it("keeps the plain empty copy when nobody was active at all", () => {
        expect(appReportEmpty("apps", false).title).toBe("No app activity");
        expect(appReportEmpty("platforms", false).title).toBe("No platform reported");
    });
});
