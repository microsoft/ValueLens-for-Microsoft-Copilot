//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import { AGENT_USAGE_HEADLINE } from "./headlines";

const COLUMNS = ["Agent", "Sessions", "Users", "Return Rate", "Organizations"];

function table(rows: unknown[][]): DataTable {
    return { columns: COLUMNS.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

describe("AGENT_USAGE_HEADLINE", () => {
    it("names the busiest of the agents shown", () => {
        const text = AGENT_USAGE_HEADLINE(
            table([
                ["Researcher", 620, 140, 0.6, 9],
                ["Analyst", 250, 60, 0.4, 5],
                ["HR helper", 130, 40, 0.3, 4],
            ]),
        );
        expect(text).toBe("Researcher is the largest, at 62% of sessions across the agents shown.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no agents, one agent or a tie", () => {
        expect(AGENT_USAGE_HEADLINE(table([]))).toBeUndefined();
        expect(AGENT_USAGE_HEADLINE(table([["Researcher", 620, 140, 0.6, 9]]))).toBeUndefined();
        expect(
            AGENT_USAGE_HEADLINE(
                table([
                    ["Researcher", 3, 1, 0, 1],
                    ["Analyst", 3, 2, 0, 1],
                ]),
            ),
        ).toBeUndefined();
    });
});
