//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { LIST_LIMIT } from "./shared";

const queries = import.meta.glob<string>("./**/*.dax", { query: "?raw", import: "default", eager: true });

/** The literal row count each `TOPN` in a query asks for, or NaN for an expression. */
function topnCounts(query: string): number[] {
    return [...query.matchAll(/TOPN\(\s*([^,]+),/g)].map(([, count]) => (/^\d+$/.test(count.trim()) ? Number(count) : NaN));
}

// Power BI's executeQueries returns at most 100,000 rows and 1,000,000 values
// per query, which a list with a row per person passes in a large tenant.
describe("per-person and per-agent lists", () => {
    const capped = [
        "./agents/agent-leaderboard.dax",
        "./agents/cowork-candidates.dax",
        "./consumption/cowork-by-group.dax",
        "./consumption/studio-users.dax",
        "./consumption/studio-agents.dax",
        "./efficiency/cowork-fit-people.dax",
        "./governance/governance-review-queue.dax",
        "./licensing/license-candidates.dax",
        "./licensing/license-candidates-m365.dax",
        "./work/leaderboard-people.dax",
    ];

    it.each(capped)("%s stops at LIST_LIMIT and counts the whole list", (path) => {
        const query = queries[path];
        expect(query, path).toBeDefined();
        expect(topnCounts(query)).toContain(LIST_LIMIT);
        expect(query).toMatch(/"Total", _?_?[A-Za-z]+/);
    });

    it("never asks TOPN for more rows than LIST_LIMIT", () => {
        for (const [path, query] of Object.entries(queries)) {
            for (const count of topnCounts(query)) {
                if (!Number.isNaN(count)) expect(count, path).toBeLessThanOrEqual(LIST_LIMIT);
            }
        }
    });
});