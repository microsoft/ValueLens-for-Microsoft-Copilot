//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { describe, expect, it } from "vitest";
import { CAUSAL_WORDS } from "@/lib/headline";
import type { AgentEntry } from "@/queries/agents";
import { agentSpotlights, namesText, readAgentFunctions } from "./agent-spotlights";

function agent(name: string, sessions: number, orgsReached: number): AgentEntry {
    return { key: name, name, inRegistry: false, users: sessions, sessions, orgsReached };
}

const entries = [agent("Finance Analyst Bot", 529, 6), agent("HR Helper", 210, 9), agent("Unused", 0, 0)];

describe("agent spotlights", () => {
    it("picks the most used agent and the one reaching the most organizations", () => {
        const cards = agentSpotlights(entries);
        expect(cards.map((card) => card.id)).toEqual(["sessions", "orgs"]);
        expect(cards[0]).toMatchObject({ names: "Finance Analyst Bot", value: 529 });
        expect(cards[0].sentence).toBe("Finance Analyst Bot had 529 sessions, more than any other agent.");
        expect(cards[1]).toMatchObject({ names: "HR Helper", value: 9 });
        expect(cards[1].sentence).toBe("HR Helper reached people in 9 organizations, more than any other agent.");
    });

    it("adds the job functions card when functions are known", () => {
        const cards = agentSpotlights(entries, [
            { name: "HR Helper", functions: 3 },
            { name: "Finance Analyst Bot", functions: 7 },
        ]);
        expect(cards.map((card) => card.id)).toEqual(["sessions", "functions", "orgs"]);
        expect(cards[1].sentence).toBe(
            "Finance Analyst Bot was used by people in 7 job functions, more than any other agent.",
        );
    });

    it("names both agents when two tie", () => {
        const cards = agentSpotlights([agent("A", 50, 3), agent("B", 50, 3)]);
        expect(cards[0].names).toBe("A and B");
        expect(cards[0].sentence).toBe("A and B each had 50 sessions, the most of any agent.");
        expect(cards[1].sentence).toBe("A and B each reached people in 3 organizations, the most of any agent.");
    });

    it("names two and counts the rest when more tie", () => {
        const cards = agentSpotlights([agent("A", 5, 1), agent("B", 5, 1), agent("C", 5, 1), agent("D", 5, 1)]);
        expect(cards[0].names).toBe("A, B and 2 others");
        expect(namesText(["A", "B", "C"])).toBe("A, B and 1 other");
    });

    it("hides cards whose winning figure singles nothing out", () => {
        expect(agentSpotlights([agent("A", 0, 0)])).toEqual([]);
        expect(agentSpotlights([agent("A", 1, 1)], [{ name: "A", functions: 1 }]).map((card) => card.id)).toEqual(["sessions"]);
        expect(agentSpotlights([agent("A", 1, 1)])[0].sentence).toBe("A had 1 session, more than any other agent.");
    });

    it("hides the job functions card when the column holds nothing", () => {
        const cards = agentSpotlights(entries, [
            { name: "HR Helper", functions: 0 },
            { name: "Finance Analyst Bot", functions: 0 },
        ]);
        expect(cards.map((card) => card.id)).not.toContain("functions");
    });

    it("makes no causal claims", () => {
        const cards = [
            ...agentSpotlights(entries, [{ name: "HR Helper", functions: 4 }]),
            ...agentSpotlights([agent("A", 9, 4), agent("B", 9, 4), agent("C", 9, 4)], [
                { name: "A", functions: 3 },
                { name: "B", functions: 3 },
            ]),
        ];
        for (const card of cards) {
            expect(card.sentence).not.toMatch(CAUSAL_WORDS);
            expect(card.label).not.toMatch(CAUSAL_WORDS);
        }
    });
});

describe("agent functions reader", () => {
    it("reads one count per agent, treating blanks as zero", () => {
        const table = {
            columns: ["Agent", "Registry Id", "Functions"].map((name) => ({ name, displayName: name })),
            rows: [
                ["HR Helper", "T_1", 4],
                ["", null, 2],
                ["Quiet", null, null],
            ],
        } as unknown as DataTable;
        expect(readAgentFunctions(table)).toEqual([
            { name: "HR Helper", functions: 4 },
            { name: "Unnamed agent", functions: 2 },
            { name: "Quiet", functions: 0 },
        ]);
    });

    it("reads nothing when the columns are missing", () => {
        const table = { columns: [{ name: "Other" }], rows: [["x"]] } as unknown as DataTable;
        expect(readAgentFunctions(table)).toEqual([]);
    });
});
