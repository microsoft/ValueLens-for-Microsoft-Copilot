//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { humanizeIdentifier, humanizeIdentifiers, parseVerdict, plainText, relabelColumn, withoutEmoji } from "./model-text";

describe("withoutEmoji", () => {
    it("drops emoji, variation selectors and the gaps they leave", () => {
        expect(withoutEmoji("⚠️ Hit an error")).toBe("Hit an error");
        expect(withoutEmoji("📚 50% of searches  answer")).toBe("50% of searches answer");
    });
});

describe("humanizeIdentifier", () => {
    it("writes CamelCase identifiers as words", () => {
        expect(humanizeIdentifier("PolicyLookup")).toBe("Policy lookup");
        expect(humanizeIdentifier("KnowledgeSearchFailed")).toBe("Knowledge search failed");
        expect(humanizeIdentifier("VPNSetupGuide")).toBe("VPN setup guide");
    });

    it("leaves product names, single words and prose alone", () => {
        expect(humanizeIdentifier("SharePoint")).toBe("SharePoint");
        expect(humanizeIdentifier("Payroll")).toBe("Payroll");
        expect(humanizeIdentifier("Pay & Expenses")).toBe("Pay & Expenses");
        expect(humanizeIdentifier("VPN")).toBe("VPN");
    });

    it("rewrites identifiers inside a sentence", () => {
        expect(humanizeIdentifiers("CancelLeave resolves best, unlike PensionContribution.")).toBe(
            "Cancel leave resolves best, unlike Pension contribution.",
        );
    });
});

describe("plainText", () => {
    it("says thumbs up and down in words before dropping emoji", () => {
        expect(plainText("68% positive (326 👍 / 154 👎).")).toBe("68% positive (326 thumbs up / 154 thumbs down).");
    });

    it("returns nothing for blank or emoji-only text", () => {
        expect(plainText(undefined)).toBeUndefined();
        expect(plainText("🟢")).toBeUndefined();
    });
});

describe("parseVerdict", () => {
    it("splits the figure from the judgement and reads the traffic light", () => {
        expect(parseVerdict("65.8% resolved  ·  🟡 Below target")).toEqual({
            figure: "65.8% resolved",
            label: "Below target",
            tone: "caution",
        });
        expect(parseVerdict("86% return · 🟢 Healthy")?.tone).toBe("positive");
        expect(parseVerdict("12% resolved · 🔴 Failing")?.tone).toBe("negative");
    });

    it("treats an unmarked verdict as neutral with no figure", () => {
        expect(parseVerdict("Comfortable")).toEqual({ figure: undefined, label: "Comfortable", tone: "neutral" });
        expect(parseVerdict("  ")).toBeUndefined();
    });
});

describe("relabelColumn", () => {
    const table = {
        columns: [{ name: "Code" }, { name: "Count" }],
        rows: [
            ["RateLimitExceeded", 3],
            [null, 1],
        ],
    } as never;

    it("rewrites only the named text column", () => {
        const result = relabelColumn(table, "Code", humanizeIdentifier);
        expect(result.rows).toEqual([
            ["Rate limit exceeded", 3],
            [null, 1],
        ]);
    });

    it("returns the table unchanged when the column is missing", () => {
        expect(relabelColumn(table, "Missing", humanizeIdentifier)).toBe(table);
    });
});
