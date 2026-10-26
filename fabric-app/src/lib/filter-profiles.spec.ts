//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    CONSUMPTION_COWORK,
    CONSUMPTION_REPORTING,
    CONSUMPTION_STUDIO_AGENT,
    consumptionOrgAttribute,
    defaultProfile,
    FEEDBACK,
    groupNotFiltered,
    notApplied,
    REGISTRY,
    resolveFilters,
    unfiltered,
    VALUE_LENS,
    withRules,
} from "./filter-profiles";
import { defaultFilters, FILTER_KEYS, filterExpression, tenantDefaultDates, tenantDefaultFilters, type FilterState } from "./filters";

const ACTIVE: FilterState = {
    dateRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
    orgAttribute: "Organization",
    organizations: ["Sales"],
    licence: "licensed",
    audience: "copilot",
    agentTypes: ["Declarative"],
    agentNames: ["Helper"],
};

describe("resolveFilters", () => {
    it("gives every active filter on ValueLens as the report's own slicer would", () => {
        const { expressions, notFilteredBy } = resolveFilters(VALUE_LENS, ACTIVE, FILTER_KEYS);
        expect(expressions).toEqual(FILTER_KEYS.map((key) => filterExpression(ACTIVE, key)));
        expect(notFilteredBy).toEqual([]);
    });

    it("skips inactive filters and keys outside the destination", () => {
        const state: FilterState = { ...defaultFilters, organizations: ["Sales"] };
        expect(resolveFilters(REGISTRY, state, ["dateRange", "organizations"]).notFilteredBy).toEqual([
            { key: "organizations", reason: expect.stringMatching(/\.$/) },
        ]);
        expect(resolveFilters(REGISTRY, state, ["dateRange", "agentTypes"])).toEqual({
            expressions: [],
            notFilteredBy: [],
        });
    });

    it("reports what a profile can't take, in key order", () => {
        const { expressions, notFilteredBy } = resolveFilters(REGISTRY, ACTIVE, FILTER_KEYS);
        expect(expressions).toHaveLength(2);
        expect(notFilteredBy.map((item) => item.key)).toEqual(["dateRange", "organizations", "licence", "audience"]);
    });
});

describe("profiles", () => {
    it("say for every filter either how it applies or why it can't", () => {
        for (const profile of [
            VALUE_LENS,
            FEEDBACK,
            REGISTRY,
            CONSUMPTION_REPORTING,
            CONSUMPTION_COWORK,
            CONSUMPTION_STUDIO_AGENT,
        ]) {
            const { expressions, notFilteredBy } = resolveFilters(profile, ACTIVE, FILTER_KEYS);
            expect(expressions.length + notFilteredBy.length).toBe(FILTER_KEYS.length);
            for (const { reason } of notFilteredBy) expect(reason).toMatch(/^\S.*\.$/);
        }
    });

    it("matches feedback to agents of the chosen type through the registry's names", () => {
        const { expressions } = resolveFilters(FEEDBACK, ACTIVE, ["agentTypes", "agentNames"]);
        expect(expressions[0]).toContain("'Agents 365'[Agent name]");
        expect(expressions[0]).toContain("'ProductFeedback'[AgentName]");
        expect(expressions[1]).toContain("'ProductFeedback'[AgentName]");
    });

    it("leaves a model other than ValueLens unfiltered unless the query says how", () => {
        expect(defaultProfile("vl", "vl")).toBe(VALUE_LENS);
        expect(resolveFilters(defaultProfile("cc", "vl"), ACTIVE, FILTER_KEYS).expressions).toEqual([]);
    });

    it("builds profiles from shared reasons and overrides", () => {
        const none = unfiltered("it is fixed.");
        expect(resolveFilters(none, ACTIVE, FILTER_KEYS).notFilteredBy).toHaveLength(FILTER_KEYS.length);
        const dated = withRules(none, { dateRange: VALUE_LENS.dateRange });
        expect(resolveFilters(dated, ACTIVE, ["dateRange"]).expressions).toEqual([filterExpression(ACTIVE, "dateRange")]);
        expect(notApplied("why.")).toEqual({ reason: "why." });
    });
});

describe("Consumption Central's org filter", () => {
    it("names the attribute as the model does", () => {
        expect(consumptionOrgAttribute("Organization")).toBe("Organisation");
        expect(consumptionOrgAttribute("department")).toBe("Department");
        expect(consumptionOrgAttribute("costCentre")).toBe("Cost Center");
        expect(consumptionOrgAttribute("displayName")).toBe("User");
        expect(consumptionOrgAttribute("Squad")).toBe("Squad");
    });

    it("narrows people through the org attributes, never the page's Group by", () => {
        const [expression] = resolveFilters(CONSUMPTION_COWORK, ACTIVE, ["organizations"]).expressions;
        expect(expression).toContain("'Org Attribute Source'[Attribute] = \"Organisation\"");
        expect(expression).toContain("'Org'[UserPrincipalName]");
        expect(expression).not.toContain("'Group By'");
    });

    it("applies while the attributes load, and says so when the model lacks the one in use", () => {
        expect(resolveFilters(CONSUMPTION_COWORK, ACTIVE, ["organizations"], {}).expressions).toHaveLength(1);
        const held = { consumptionOrgAttributes: ["Organisation"] };
        expect(resolveFilters(CONSUMPTION_COWORK, ACTIVE, ["organizations"], held).expressions).toHaveLength(1);
        const missing = { consumptionOrgAttributes: ["Department"] };
        expect(resolveFilters(CONSUMPTION_COWORK, ACTIVE, ["organizations"], missing).notFilteredBy).toEqual([
            { key: "organizations", reason: "Consumption Central has no organization for people." },
        ]);
    });
});

describe("groupNotFiltered", () => {
    it("says each reason once, with every filter it covers", () => {
        expect(
            groupNotFiltered([
                [{ key: "dateRange", reason: "a." }],
                undefined,
                [
                    { key: "organizations", reason: "a." },
                    { key: "dateRange", reason: "a." },
                    { key: "agentNames", reason: "b." },
                ],
            ]),
        ).toEqual([
            { keys: ["dateRange", "organizations"], reason: "a." },
            { keys: ["agentNames"], reason: "b." },
        ]);
    });
});

describe("resolveFilters under the tenant's default dates", () => {
    it("applies the window worked out in the query on ValueLens, whatever the options say", () => {
        for (const largeTenant of [true, false, undefined]) {
            const resolved = resolveFilters(VALUE_LENS, tenantDefaultFilters, FILTER_KEYS, { largeTenant });
            expect(resolved.expressions).toEqual([tenantDefaultDates()]);
            expect(resolved.notFilteredBy).toEqual([]);
        }
        expect(resolveFilters(FEEDBACK, tenantDefaultFilters, ["dateRange"]).expressions).toEqual([tenantDefaultDates()]);
    });

    it("keeps every date on Consumption Central, saying so only on a large tenant", () => {
        for (const profile of [CONSUMPTION_REPORTING]) {
            const large = resolveFilters(profile, tenantDefaultFilters, ["dateRange"], { largeTenant: true });
            expect(large.expressions).toEqual([]);
            expect(large.notFilteredBy).toHaveLength(1);
            expect(large.notFilteredBy[0].reason).toMatch(/^the default last 12 weeks follows Copilot activity, so .+ keeps every date until you choose a range\.$/);

            for (const largeTenant of [false, undefined]) {
                const small = resolveFilters(profile, tenantDefaultFilters, ["dateRange"], { largeTenant });
                expect(small).toEqual({ expressions: [], notFilteredBy: [] });
            }
        }
    });

    it("still applies a chosen range on Consumption Central", () => {
        expect(resolveFilters(CONSUMPTION_REPORTING, ACTIVE, ["dateRange"]).expressions[0]).toContain("'Reporting Date'[Date]");
    });

    it("says a stage with its own period isn't filtered by the default only on a large tenant", () => {
        expect(resolveFilters(CONSUMPTION_COWORK, tenantDefaultFilters, ["dateRange"], { largeTenant: true }).notFilteredBy).toHaveLength(1);
        expect(resolveFilters(CONSUMPTION_COWORK, tenantDefaultFilters, ["dateRange"], { largeTenant: false }).notFilteredBy).toEqual([]);
    });
});
