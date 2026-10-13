//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { describeFreshness, formatFreshnessDate, PAGE_SOURCES } from "./freshness";

const today = new Date("2026-10-08T12:00:00Z");

describe("formatFreshnessDate", () => {
    it("gives a short day and month within the current year", () => {
        expect(formatFreshnessDate("2026-10-07T00:00:00", today)).toBe("7 Oct");
        expect(formatFreshnessDate("2026-01-31", today)).toBe("31 Jan");
    });

    it("adds the year outside the current one", () => {
        expect(formatFreshnessDate("2025-12-30T00:00:00", today)).toBe("30 Dec 2025");
    });

    it("reads the calendar date without a time zone shift", () => {
        expect(formatFreshnessDate("2026-10-07T23:30:00", today)).toBe("7 Oct");
    });

    it("hides blank or unreadable dates", () => {
        expect(formatFreshnessDate(undefined, today)).toBeUndefined();
        expect(formatFreshnessDate(null, today)).toBeUndefined();
        expect(formatFreshnessDate("", today)).toBeUndefined();
        expect(formatFreshnessDate("not a date", today)).toBeUndefined();
        expect(formatFreshnessDate("2026-02-30", today)).toBeUndefined();
    });
});

describe("describeFreshness", () => {
    it("lists each source with its date, in page order", () => {
        expect(
            describeFreshness(["auditLog", "copilotStudio"], { auditLog: "2026-10-07T00:00:00", copilotStudio: "2026-10-06" }, today),
        ).toBe("Audit log to 7 Oct · Copilot Studio to 6 Oct");
    });

    it("says Cowork's date starts a week", () => {
        expect(describeFreshness(["cowork"], { cowork: "2026-09-28T00:00:00" }, today)).toBe("Cowork to week of 28 Sept");
    });

    it("leaves out sources without a date", () => {
        expect(describeFreshness(["cowork", "copilotStudio", "azure"], { copilotStudio: "2026-10-06", azure: null }, today)).toBe(
            "Copilot Studio to 6 Oct",
        );
    });

    it("is undefined when no source has a date", () => {
        expect(describeFreshness(["auditLog"], {}, today)).toBeUndefined();
        expect(describeFreshness([], { auditLog: "2026-10-07" }, today)).toBeUndefined();
    });
});

describe("PAGE_SOURCES", () => {
    it("points each page at the data it draws on", () => {
        expect(PAGE_SOURCES.executive).toEqual(["auditLog"]);
        expect(PAGE_SOURCES["work-patterns"]).toEqual(["m365Activity"]);
        expect(PAGE_SOURCES.feedback).toEqual(["productFeedback"]);
        expect(PAGE_SOURCES.governance).toEqual(["agentRegistry"]);
        expect(PAGE_SOURCES.consumption).toEqual(["cowork", "copilotStudio", "azure"]);
        expect(PAGE_SOURCES["agent-evaluation"]).toEqual(["agentEvaluation"]);
        expect(PAGE_SOURCES.assumptions).toEqual([]);
    });
});
