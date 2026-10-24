//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation. All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import cowork from "./agents/cowork-candidates.dax?raw";
import license from "./licensing/license-candidates.dax?raw";
import m365 from "./licensing/license-candidates-m365.dax?raw";

describe("candidate rank contracts (offline, not DAX execution)", () => {
    it("keeps Cowork eligibility and score components from the original user-level measure", () => {
        expect(cowork).toContain("[@cw] = 0 && NOT ISBLANK([@b]) && NOT ISBLANK([@d])");
        expect(cowork).toContain("KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is_Cowork] = FALSE())");
        expect(cowork).toContain("45 * MIN(DIVIDE([@b], __MaxB, 0), 1)");
        expect(cowork).toContain("35 * MIN(DIVIDE([@d], __MaxD, 0), 1)");
        expect(cowork).toContain("20 * [@a]");
        expect(cowork.indexOf("VAR __Scores")).toBeLessThan(cowork.indexOf("TOPN("));
        expect(cowork.indexOf("VAR __Depths")).toBeLessThan(cowork.indexOf("TOPN("));
    });

    it("keeps the licence rank population separate from candidates with observed sessions", () => {
        const scores = license.slice(license.indexOf("VAR __Scores"), license.indexOf("VAR __Candidates"));
        expect(scores).toContain("'Chat + Agent Interactions (Audit Logs)'[License Status] = \"Unlicensed\"");
        expect(scores).not.toContain("KEEPFILTERS");
        expect(license).toContain("FILTER(__Scored, CALCULATE([Observed Unlicensed Sessions]) > 0)");
        expect(license.indexOf("VAR __Scores")).toBeLessThan(license.indexOf("TOPN("));
        expect(m365.indexOf("VAR _scores")).toBeLessThan(m365.indexOf("TOPN("));
    });

    it("one plus distinct higher scores matches dense rank, including ties and inserted values", () => {
        const scores = [100, 100, 85, 70, 70, 0];
        for (const score of [100, 90, 85, 70, 50, 0]) {
            // RANKX inserts a current score absent from its comparison population.
            const reference = [...new Set([...scores, score])].sort((a, b) => b - a).indexOf(score) + 1;
            const sharedTableRank = new Set(scores.filter((value) => value > score)).size + 1;
            expect(sharedTableRank).toBe(reference);
        }
    });

    it("uses stable person keys after score ties, without changing dense ranks at the cap", () => {
        for (const query of [cowork, license, m365]) {
            expect(query).toMatch(/TOPN\(\s*1000,/);
            expect(query).toMatch(/'Chat \+ Agent Interactions \(Audit Logs\)'\[Audit_UserId\], ASC/);
            expect(query).toMatch(/COUNTROWS\(FILTER\(_?_[Ss]cores, \[@Value\] > _?_[Ss]core\)\) \+ 1/);
        }
        const all = Array.from({ length: 1500 }, (_, i) => ({ key: `user${String(i).padStart(4, "0")}`, score: 80 }));
        const listed = all.slice().reverse().sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 1000);
        expect(listed[999].key).toBe("user0999");
        expect(listed.every((person) => new Set(all.filter((other) => other.score > person.score).map((other) => other.score)).size + 1 === 1)).toBe(true);
    });
});
