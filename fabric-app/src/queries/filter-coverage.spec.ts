//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { applyDaxFilters } from "@/lib/dax-filters";
import { defaultProfile, resolveFilters, type FilterProfile } from "@/lib/filter-profiles";
import { FILTER_KEYS, type FilterKey, type FilterState } from "@/lib/filters";
import { connection as valueLens } from "./shared";

/**
 * Every query factory the app's pages read, checked against the filter bar
 * with every filter on: each filter either reaches the query as a DAX
 * argument or comes back with a reason the card can show.
 */

interface Factory {
    name: string;
    connection: string;
    query: string;
    filters?: FilterProfile;
}

const ACTIVE: FilterState = {
    dateRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
    orgAttribute: "Organization",
    organizations: ["Sales"],
    licence: "licensed",
    audience: "copilot",
    agentTypes: ["Declarative"],
    agentNames: ["Helper"],
};

function isSource(value: unknown): value is Omit<Factory, "name"> {
    if (typeof value !== "object" || value === null) return false;
    const source = value as Record<string, unknown>;
    return typeof source.connection === "string" && typeof source.query === "string" && /\bEVALUATE\b/.test(source.query);
}

function collectFactories(): Factory[] {
    const modules = import.meta.glob<Record<string, unknown>>("./*/index.ts", { eager: true });
    const seen = new Set<unknown>();
    const factories: Factory[] = [];
    for (const [path, module] of Object.entries(modules)) {
        for (const [name, exported] of Object.entries(module)) {
            if (typeof exported !== "function" || seen.has(exported)) continue;
            seen.add(exported);
            let source: unknown;
            try {
                source = (exported as () => unknown)();
            } catch {
                continue;
            }
            if (isSource(source)) factories.push({ ...source, name: `${path.split("/")[1]}/${name}` });
        }
    }
    return factories.sort((a, b) => a.name.localeCompare(b.name));
}

const factories = collectFactories();
const byConnection = (id: string) => factories.filter((factory) => factory.connection === id);
const profileOf = (factory: Factory) => factory.filters ?? defaultProfile(factory.connection, valueLens);
const resolve = (factory: Factory, keys: readonly FilterKey[] = FILTER_KEYS) =>
    resolveFilters(profileOf(factory), ACTIVE, keys);

function applied(name: string): FilterKey[] {
    const factory = factories.find((candidate) => candidate.name === name);
    if (!factory) throw new Error(`No factory ${name}`);
    const { notFilteredBy } = resolve(factory);
    const skipped = new Set(notFilteredBy.map((item) => item.key));
    return FILTER_KEYS.filter((key) => !skipped.has(key));
}

describe("query factories and the filter bar", () => {
    it("finds the factories on every model", () => {
        expect(byConnection("vl").length).toBeGreaterThan(50);
        expect(byConnection("cc").length).toBeGreaterThan(10);
        expect(factories.every((factory) => [valueLens, "cc"].includes(factory.connection))).toBe(true);
    });

    it.each(factories.map((factory) => [factory.name, factory] as const))(
        "%s applies every active filter it can and explains the rest",
        (_name, factory) => {
            const { expressions, notFilteredBy } = resolve(factory);
            expect(expressions.length + notFilteredBy.length).toBe(FILTER_KEYS.length);
            for (const { reason } of notFilteredBy) expect(reason).toMatch(/^\S.*\.$/);

            const query = applyDaxFilters(factory.query, expressions);
            for (const expression of expressions) expect(query).toContain(expression);
            if (expressions.length > 0) expect(query).toContain("CALCULATETABLE(");
        },
    );

    it("says how each query on another model takes the filter bar", () => {
        const untagged = factories
            .filter((factory) => factory.connection !== valueLens && factory.filters === undefined)
            .map((factory) => factory.name);
        expect(untagged).toEqual([]);
    });

    it("gives ValueLens queries without their own profile every filter", () => {
        for (const factory of byConnection(valueLens).filter((candidate) => candidate.filters === undefined)) {
            expect(resolve(factory).notFilteredBy).toEqual([]);
        }
    });

    it("narrows feedback by date and agent", () => {
        for (const name of ["feedback/feedbackSummary", "feedback/feedbackTrend", "feedback/feedbackComments"]) {
            expect(applied(name)).toEqual(["dateRange", "agentTypes", "agentNames"]);
        }
    });

    it("narrows the agent registry by agent type and name", () => {
        for (const name of ["governance/governanceSummary", "governance/governanceExposure", "governance/governanceReviewQueue"]) {
            expect(applied(name)).toEqual(["agentTypes", "agentNames"]);
        }
    });

    it("narrows Consumption Central by the org filter where credits are per person", () => {
        const perPerson = byConnection("cc").filter((factory) => applied(factory.name).includes("organizations"));
        expect(perPerson.length).toBeGreaterThan(0);
        for (const factory of perPerson) {
            const [expression] = resolve(factory, ["organizations"]).expressions;
            expect(expression).toContain("'Org'[UserPrincipalName]");
        }
    });
});
