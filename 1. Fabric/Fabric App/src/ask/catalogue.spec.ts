//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { destinations } from "@/components/destinations";
import { MIN_PEOPLE } from "@/lib/headline";
import { consumptionConnection, evaluatorConnection, connection } from "@/queries/shared";
import { askCatalogue } from "./catalogue";

const queries = import.meta.glob<string>("../queries/**/*.dax", { query: "?raw", import: "default", eager: true });
const ISSUE_PROMPTS = [
    "What's the bottom line this month, and what changed?",
    "Which orgs have the lowest activation?",
    "Who are heavy users without a licence?",
    "Will we stay within the Cowork budget?",
    "Which tasks deliver the most expert-equivalent hours?",
    "Where are we using a premium model for simple work?",
    "Which agents have no active owner?",
    "Which agent topics answer worst?",
];

describe("ask catalogue", () => {
    const destinationIds = new Set<string>(destinations.map((d) => d.id));

    it("uses the app's own minimum number of people", () => {
        expect(askCatalogue.minPeople).toBe(MIN_PEOPLE);
    });

    it("suggests questions only for destinations the app has, once each", () => {
        const ids = askCatalogue.pages.map((page) => page.destination);
        expect(new Set(ids).size).toBe(ids.length);
        for (const page of askCatalogue.pages) {
            expect(destinationIds.has(page.destination), page.destination).toBe(true);
            expect(page.questions.length).toBeGreaterThan(0);
        }
    });

    it("keeps the suggested prompts the issue asked for", () => {
        const all = askCatalogue.pages.flatMap((page) => page.questions);
        for (const prompt of ISSUE_PROMPTS) expect(all).toContain(prompt);
    });

    it("names each tool once, in a form models accept", () => {
        const names = askCatalogue.tools.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    });

    it("points every tool at a query the app runs, on a model it knows", () => {
        const aliases = new Set([connection, consumptionConnection, evaluatorConnection]);
        for (const tool of askCatalogue.tools) {
            const text = queries[`../queries/${tool.query}`];
            expect(text, tool.query).toBeTypeOf("string");
            expect(text, tool.query).not.toMatch(/__[A-Z_]+__/);
            expect(aliases.has(tool.model), tool.name).toBe(true);
            expect(destinationIds.has(tool.page), tool.name).toBe(true);
            expect(tool.description.length, tool.name).toBeGreaterThan(20);
        }
    });

    it("lets only the main model's queries take the filter bar's filters", () => {
        for (const tool of askCatalogue.tools) {
            for (const filter of tool.filters) expect(["dateRange", "organizations"]).toContain(filter);
            if (tool.model !== connection) expect(tool.filters, tool.name).toEqual([]);
        }
    });

    it("counts people only by columns the query returns", () => {
        for (const tool of askCatalogue.tools.filter((t) => t.people)) {
            const text = queries[`../queries/${tool.query}`];
            for (const column of tool.people!) expect(text, `${tool.name}: ${column}`).toContain(`"${column}"`);
        }
    });
});
