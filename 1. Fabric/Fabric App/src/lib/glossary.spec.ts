//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { destinations } from "@/components/destinations";
import glossaryRows from "@/queries/appendix/__fixtures__/glossary.rows.json";
import { GLOSSARY_PAGE_HOME, highlightParts, searchGlossary, toGlossaryPages } from "./glossary";

const pages = toGlossaryPages(glossaryRows as Record<string, unknown>[]);

describe("toGlossaryPages", () => {
    it("keeps every metric, grouped into the report's pages in order", () => {
        expect(pages).toHaveLength(15);
        expect(pages.reduce((total, page) => total + page.entries.length, 0)).toBe(98);
        expect(pages[0].page).toBe("Activation");
        expect(pages.at(-1)?.page).toBe("Appendix: Signal - Impact Table");
    });

    it("orders metrics by the report's metric order, not by name", () => {
        const rows = [
            { "[Page]": "P", "[Metric]": "Zeta", "[Description]": "z", "[Page Order]": 0, "[Metric Order]": 0 },
            { "[Page]": "P", "[Metric]": "Alpha", "[Description]": "a", "[Page Order]": 0, "[Metric Order]": 1 },
        ];
        expect(toGlossaryPages(rows)[0].entries.map((entry) => entry.metric)).toEqual(["Zeta", "Alpha"]);
    });

    it("drops rows without a page or metric", () => {
        const rows = [
            { "[Page]": "P", "[Metric]": null, "[Page Order]": 0 },
            { "[Page]": "", "[Metric]": "M", "[Page Order]": 0 },
        ];
        expect(toGlossaryPages(rows)).toEqual([]);
    });

    it("carries each page's description", () => {
        expect(pages[0].description).toMatch(/license inventory/);
    });
});

describe("searchGlossary", () => {
    it("returns everything for a blank term", () => {
        expect(searchGlossary(pages, "   ")).toHaveLength(pages.length);
    });

    it("matches metric names and definitions case-insensitively", () => {
        const result = searchGlossary(pages, "ACTIVE USERS");
        expect(result.length).toBeGreaterThan(0);
        for (const page of result) {
            for (const entry of page.entries) {
                expect(`${entry.metric} ${entry.description}`.toLowerCase()).toContain("active users");
            }
        }
    });

    it("keeps a whole page when its name matches", () => {
        const modelMix = searchGlossary(pages, "model mix").find((page) => page.page === "Model Mix");
        expect(modelMix?.entries).toHaveLength(pages.find((page) => page.page === "Model Mix")!.entries.length);
    });

    it("drops pages left with no matches", () => {
        expect(searchGlossary(pages, "zzzz-not-a-metric")).toEqual([]);
    });
});

describe("highlightParts", () => {
    it("splits around every occurrence, keeping the original case", () => {
        expect(highlightParts("Active users and active days", "active")).toEqual([
            { text: "Active", match: true },
            { text: " users and ", match: false },
            { text: "active", match: true },
            { text: " days", match: false },
        ]);
    });

    it("returns the text whole for a blank term", () => {
        expect(highlightParts("Sessions", " ")).toEqual([{ text: "Sessions", match: false }]);
    });
});

describe("GLOSSARY_PAGE_HOME", () => {
    it("places every report page in the glossary", () => {
        for (const page of pages) {
            expect(GLOSSARY_PAGE_HOME, page.page).toHaveProperty([page.page]);
        }
    });

    it("points only at stages that exist", () => {
        for (const home of Object.values(GLOSSARY_PAGE_HOME)) {
            const destination = destinations.find((candidate) => candidate.id === home.destination);
            expect(destination).toBeDefined();
            if (home.stage) {
                expect(destination!.stages.map((stage) => stage.id as string)).toContain(home.stage);
            }
        }
    });
});
