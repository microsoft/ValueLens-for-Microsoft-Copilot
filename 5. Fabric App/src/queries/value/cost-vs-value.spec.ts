//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import {
    agentKey,
    agentTable,
    compare,
    costValueSpec,
    DAYS_PER_MONTH,
    isDollar,
    licenceCost,
    matchAgents,
    overlapSpan,
    pairLines,
    pairTable,
    readAgentCredits,
    readAgentValues,
    readSourceValues,
    returnOn,
    scenarioValue,
    spanDays,
    toValueCurrency,
    type Costs,
} from "./cost-vs-value";

/** Value by source and scenario at £50 an hour, as the live model returned it for Jun–Aug 2026. */
const bySource: DataTable = {
    columns: [{ name: "Source" }, { name: "Scenario" }, { name: "Hours" }, { name: "Value" }],
    rows: [
        ["Agents", "Conservative", 286.3, 14316],
        ["Agents", "Optimistic", 966.2, 48311],
        ["Agents", "Typical", 682.7, 34135],
        ["Copilot", "Conservative", 899.1, 44956],
        ["Copilot", "Optimistic", 2620.4, 131021],
        ["Copilot", "Typical", 1937.4, 96872],
        ["Cowork", "Conservative", 32.1, 1603],
        ["Cowork", "Optimistic", 109.7, 5486],
        ["Cowork", "Typical", 69.5, 3474],
    ],
};

describe("dates compared", () => {
    it("takes the days both spans cover", () => {
        expect(overlapSpan({ from: "2026-06-01", to: "2026-08-31" }, { from: "2026-05-03", to: "2026-07-31" })).toEqual({
            from: "2026-06-01",
            to: "2026-07-31",
        });
    });

    it("has no overlap when the spans miss, or either is unknown", () => {
        expect(overlapSpan({ from: "2026-06-01", to: "2026-06-30" }, { from: "2026-07-01", to: "2026-07-31" })).toBeUndefined();
        expect(overlapSpan(undefined, { from: "2026-07-01", to: "2026-07-31" })).toBeUndefined();
    });

    it("counts both ends of the span", () => {
        expect(spanDays({ from: "2026-06-01", to: "2026-07-31" })).toBe(61);
        expect(spanDays({ from: "2026-07-01", to: "2026-07-01" })).toBe(1);
    });

    it("counts across a clock change as whole days", () => {
        expect(spanDays({ from: "2026-03-01", to: "2026-03-31" })).toBe(31);
    });
});

describe("licence cost", () => {
    it("spreads the monthly price over the days compared", () => {
        const cost = licenceCost(112, 30, { from: "2026-06-01", to: "2026-07-31" });
        expect(cost).toBeCloseTo(112 * 30 * (61 / DAYS_PER_MONTH), 6);
        expect(cost).toBeCloseTo(6733.8, 1);
    });

    it("is a year's price over a year of days", () => {
        expect(licenceCost(1, 30, { from: "2025-01-01", to: "2025-12-31" })).toBeCloseTo(360 * (365 / 365.25), 6);
    });
});

describe("currency", () => {
    it("recognises the dollar however the model spells it", () => {
        for (const symbol of ["$", " $ ", "US$", "USD", "usd"]) expect(isDollar(symbol)).toBe(true);
        for (const symbol of ["£", "€", "A$", ""]) expect(isDollar(symbol)).toBe(false);
    });

    it("leaves a dollar cost as it is when value is in dollars", () => {
        expect(toValueCurrency(100, "$", undefined)).toBe(100);
        expect(toValueCurrency(100, "$", 0.75)).toBe(100);
    });

    it("converts at the exchange rate, and gives nothing without one", () => {
        expect(toValueCurrency(100, "£", 0.75)).toBe(75);
        expect(toValueCurrency(100, "£", undefined)).toBeUndefined();
        expect(toValueCurrency(undefined, "£", 0.75)).toBeUndefined();
    });
});

describe("value by source", () => {
    const values = readSourceValues(bySource);

    it("reads each source under each scenario", () => {
        expect(values.get("Copilot")).toEqual({ Conservative: 44956, Optimistic: 131021, Typical: 96872 });
        expect([...values.keys()].sort()).toEqual(["Agents", "Copilot", "Cowork"]);
    });

    it("adds the sources up under one scenario", () => {
        expect(scenarioValue(values, "Typical")).toBe(34135 + 96872 + 3474);
    });

    it("skips rows with no source or an unknown scenario", () => {
        const odd = readSourceValues({
            columns: bySource.columns,
            rows: [
                [null, "Typical", 1, 10],
                ["Copilot", "Heroic", 1, 10],
                ["Copilot", "Typical", 1, 10],
            ],
        });
        expect(odd.size).toBe(1);
        expect(odd.get("Copilot")).toEqual({ Typical: 10 });
    });

    it("reads nothing before the query answers", () => {
        expect(readSourceValues(undefined).size).toBe(0);
        expect(scenarioValue(readSourceValues(undefined), "Typical")).toBeUndefined();
    });
});

describe("comparison", () => {
    const values = readSourceValues(bySource);
    const costs: Costs = { licences: 5000, studio: 500, cowork: 7500 };

    it("sets all the value against licences and credits", () => {
        const result = compare(values, costs, "Typical", 50);
        expect(result.cost).toBe(13000);
        expect(result.credits).toBe(8000);
        expect(result.value).toBe(134481);
        expect(result.ratio).toBeCloseTo(134481 / 13000, 9);
        expect(result.low).toBeCloseTo((14316 + 44956 + 1603) / 13000, 9);
        expect(result.high).toBeCloseTo((48311 + 131021 + 5486) / 13000, 9);
    });

    it("gives the rate at which value would just cover cost", () => {
        const result = compare(values, costs, "Typical", 50);
        expect(result.breakEvenRate).toBeCloseTo((50 * 13000) / 134481, 9);
    });

    it("counts licences alone when there are no credit costs", () => {
        const result = compare(values, { licences: 5000, studio: undefined, cowork: undefined }, "Typical", 50);
        expect(result.cost).toBe(5000);
        expect(result.credits).toBeUndefined();
    });

    it("has no cost or return until the licences can be priced", () => {
        const result = compare(values, { licences: undefined, studio: 500, cowork: 7500 }, "Typical", 50);
        expect(result.cost).toBeUndefined();
        expect(result.ratio).toBeUndefined();
        expect(result.breakEvenRate).toBeUndefined();
        expect(result.value).toBe(134481);
    });

    it("has no return on a zero cost", () => {
        expect(returnOn(100, 0)).toBeUndefined();
        expect(returnOn(undefined, 10)).toBeUndefined();
        expect(returnOn(30, 10)).toBe(3);
    });
});

describe("pairs", () => {
    const values = readSourceValues(bySource);
    const costs: Costs = { licences: 5000, studio: 500, cowork: 7500 };

    it("sets each cost against the activity it pays for", () => {
        const lines = pairLines(values, costs, "Typical", ["licences", "studio", "cowork"]);
        expect(lines.map((line) => [line.id, line.cost, line.value])).toEqual([
            ["licences", 5000, 96872],
            ["studio", 500, 34135],
            ["cowork", 7500, 3474],
        ]);
        expect(lines[2].ratio).toBeCloseTo(3474 / 7500, 9);
    });

    it("keeps only the pairs asked for", () => {
        expect(pairLines(values, costs, "Typical", ["licences"]).map((line) => line.id)).toEqual(["licences"]);
    });

    it("lays the pairs out as one table in order, with blanks as null", () => {
        const table = pairTable(pairLines(values, { ...costs, cowork: undefined }, "Typical", ["licences", "cowork"]));
        expect(table.columns.map((column) => column.name)).toEqual(["Pair", "Cost Line", "Cost", "Set Against", "Value", "Return", "Sort"]);
        expect(table.rows).toHaveLength(2);
        expect(table.rows[1][2]).toBeNull();
        expect(table.rows[1][5]).toBeNull();
        expect(table.rows.map((row) => row[6])).toEqual([0, 1]);
    });
});

describe("agents", () => {
    const values = readAgentValues({
        columns: [{ name: "Agent" }, { name: "Sessions" }, { name: "Hours" }, { name: "Value" }],
        rows: [
            ["Researcher", 900, 400, 20000],
            ["ServiceNow Assistant", 120, 50.6, 2529],
            ["Workday  Assistant", 110, 48.8, 2442],
            ["SAP Assistant ", 40, 16.8, 842],
        ],
    });
    const credits = readAgentCredits({
        columns: [{ name: "Agent" }, { name: "Credits Used" }, { name: "Credit Share" }],
        rows: [
            ["ServiceNow Assistant", 17301, 0.2],
            ["sap assistant", 16071, 0.2],
            ["Onboarding Buddy", 14552, 0.2],
            ["Workday Assistant", 11713, 0.2],
            ["No Credits", null, 0],
        ],
    });

    it("matches names however each model spaces or cases them", () => {
        expect(agentKey("  Workday   Assistant ")).toBe("workday assistant");
        const match = matchAgents(values, credits, 1000);
        expect(match.lines.map((line) => line.name)).toEqual(["ServiceNow Assistant", "Workday  Assistant", "SAP Assistant "]);
    });

    it("lists the Copilot Studio agents with no activity by that name", () => {
        const match = matchAgents(values, credits, 1000);
        expect(match.unmatched).toEqual(["Onboarding Buddy"]);
        expect(match.total).toBe(4);
    });

    it("splits Copilot Studio's cost by each agent's share of all its credits", () => {
        const total = 17301 + 16071 + 14552 + 11713;
        const match = matchAgents(values, credits, 1000);
        const serviceNow = match.lines.find((line) => line.name === "ServiceNow Assistant")!;
        expect(serviceNow.share).toBeCloseTo(17301 / total, 9);
        expect(serviceNow.cost).toBeCloseTo((1000 * 17301) / total, 9);
        expect(serviceNow.ratio).toBeCloseTo(2529 / serviceNow.cost!, 9);
        const allocated = match.lines.reduce((sum, line) => sum + (line.cost ?? 0), 0);
        expect(allocated).toBeLessThan(1000);
    });

    it("leaves cost and return blank until Copilot Studio's cost is known", () => {
        const match = matchAgents(values, credits, undefined);
        expect(match.lines.every((line) => line.cost === undefined && line.ratio === undefined)).toBe(true);
        expect(match.lines[0].share).toBeGreaterThan(0);
    });

    it("lays the agents out with the same Pair column the chart reads", () => {
        const table = agentTable(matchAgents(values, credits, 1000).lines);
        expect(table.columns.map((column) => column.name)).toEqual(["Pair", "Share", "Cost", "Sessions", "Value", "Return", "Sort"]);
        expect(table.rows[0][0]).toBe("ServiceNow Assistant");
    });
});

describe("cost and value chart", () => {
    it("labels its axis in the value's currency", () => {
        expect(JSON.stringify(costValueSpec("£"))).toContain("'£' + format(datum.value");
        expect(JSON.stringify(costValueSpec("£"))).not.toContain("__CURRENCY__");
    });

    it("can't be broken out of its expression by the symbol", () => {
        const text = JSON.stringify(costValueSpec(`£'"\\`));
        expect(text).toContain("'£' + format(datum.value");
    });
});
