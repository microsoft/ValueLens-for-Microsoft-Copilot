//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { destinations } from "@/components/destinations";
import {
    copyOfPack,
    BUILT_IN_PACKS,
    dataToSuffix,
    destinationPack,
    earliestDate,
    exportFileName,
    isStageId,
    MAX_PACK_NAME,
    packFilters,
    packRuns,
    packSources,
    parsePack,
    stageDestination,
} from "./report-pack";

const all = [...destinations];
const without = (id: string) => all.filter((destination) => destination.id !== id);

describe("built-in packs", () => {
    it("only name stages the app has", () => {
        for (const pack of BUILT_IN_PACKS) {
            expect(parsePack(pack)?.stages).toEqual(pack.stages);
        }
    });
});

describe("parsePack", () => {
    it("drops unknown and repeated stages and caps the name", () => {
        const pack = parsePack({
            id: "p1",
            name: `  ${"x".repeat(MAX_PACK_NAME + 20)}  `,
            stages: ["activation", "nope", "activation", "budget-runway"],
        });
        expect(pack?.stages).toEqual(["activation", "budget-runway"]);
        expect(pack?.name).toHaveLength(MAX_PACK_NAME);
    });

    it("reads stages stored as JSON text", () => {
        expect(parsePack({ id: "p1", name: "A", stages: '["glossary"]' })?.stages).toEqual(["glossary"]);
    });

    it("rejects a pack with no name, no stages or unreadable stages", () => {
        expect(parsePack({ id: "p1", name: " ", stages: ["glossary"] })).toBeUndefined();
        expect(parsePack({ id: "p1", name: "A", stages: ["nope"] })).toBeUndefined();
        expect(parsePack({ id: "p1", name: "A", stages: "{" })).toBeUndefined();
        expect(parsePack(null)).toBeUndefined();
    });

    it("leaves Ask out, as a conversation can't be exported", () => {
        expect(parsePack({ id: "p1", name: "A", stages: ["ask", "glossary"] })?.stages).toEqual(["glossary"]);
        expect(isStageId("ask")).toBe(false);
    });
});

describe("packRuns", () => {
    it("groups consecutive stages by destination, keeping pack order", () => {
        const { runs, missing } = packRuns(["adoption", "activation", "leaderboard", "habit-formation"], all);
        expect(runs.map((run) => [run.destination.id, run.stages])).toEqual([
            ["adoption", ["adoption", "activation"]],
            ["leaderboards", ["leaderboard"]],
            ["adoption", ["habit-formation"]],
        ]);
        expect(missing).toEqual([]);
    });

    it("starts a new run where the pack goes back up a destination's page, as a screen draws in page order", () => {
        const { runs } = packRuns(["what-needs-attention", "the-bottom-line", "is-it-growing"], all);
        expect(runs.map((run) => run.stages)).toEqual([["what-needs-attention"], ["the-bottom-line", "is-it-growing"]]);
    });

    it("leaves out stages from destinations this install doesn't have", () => {
        const { runs, missing } = packRuns(["consumption-overview", "cost-vs-value"], without("consumption"));
        expect(runs.map((run) => run.destination.id)).toEqual(["value"]);
        expect(missing).toEqual(["consumption-overview"]);
    });
});

describe("packFilters and packSources", () => {
    it("unions the runs' slicers in filter bar order and their sources", () => {
        const { runs } = packRuns(["budget-runway", "estate-health", "the-bottom-line"], all);
        expect(packFilters(runs)).toEqual(["dateRange", "organizations", "agentTypes", "agentNames"]);
        expect(packSources(runs)).toEqual(["cowork", "copilotStudio", "azure", "agentRegistry", "auditLog"]);
    });
});

describe("destinationPack", () => {
    it("holds every stage of the page", () => {
        expect(destinationPack(stageDestination("glossary")).stages).toEqual(["glossary", "signal-impact"]);
    });
});

describe("export file names", () => {
    it("adds the date the data runs to when it is known", () => {
        expect(exportFileName("Exec pre-read", "2026-07-06T00:00:00Z", "pptx")).toBe("exec-pre-read-data-to-2026-07-06.pptx");
        expect(exportFileName("Exec pre-read", undefined, "pdf")).toBe("exec-pre-read.pdf");
        expect(dataToSuffix("not a date")).toBe("");
    });

    it("takes the earliest of the sources' last dates", () => {
        expect(earliestDate(["2026-07-06", null, "2026-06-30T00:00:00Z", undefined])).toBe("2026-06-30");
        expect(earliestDate([null])).toBeUndefined();
    });
});

describe("copyOfPack", () => {
    it("copies a pack under a new id and name, as the user's own", () => {
        const [original] = BUILT_IN_PACKS;
        const copy = copyOfPack(original);
        expect(copy.id).not.toBe(original.id);
        expect(copy.name).toBe(`${original.name} (copy)`);
        expect(copy.stages).toEqual(original.stages);
        expect(copy.stages).not.toBe(original.stages);
        expect(copy.builtIn).toBeUndefined();
        expect(copyOfPack({ ...original, name: "x".repeat(80) }).name).toHaveLength(80);
    });
});
