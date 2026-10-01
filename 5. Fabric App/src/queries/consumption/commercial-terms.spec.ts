//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    daxNumber,
    hasCommercialTerms,
    modelCommercialTerms,
    parseTerm,
    readsCommercialTerms,
    validateTerm,
    withCommercialTerms,
} from "./commercial-terms";
import { RATE_MEASURES } from "./rate-measures";

const queries = import.meta.glob<string>("./*.dax", { query: "?raw", import: "default", eager: true });

/**
 * Every measure in the released Consumption Central template that reads a
 * rate or the pack balance, directly or through another measure.
 */
const RATE_DEPENDENT = [
    "Action Value /mo", "All Cost /mo", "All Cost /mo (incl Foundry)", "Allocated Budget $",
    "Billable Credit Cost (Agent)", "Billable Credit Cost (User)", "Billed Cost", "Billing Basis",
    "Blended Rate $", "Chargeback", "Chargeback $", "Chargeback per User $", "Contracted Cost",
    "Contracted Unit Price", "Cost in Action", "Cost per Consumed Credit", "Cost per Studio User",
    "Cowork Cost /mo", "Cowork Forecast Summary", "Cowork PAYG Cost", "Cowork PAYG Credits",
    "Cowork PAYG Rate", "Cowork PAYG Share of Cost %", "Cowork Prepaid Balance", "Cowork Prepaid Cost",
    "Cowork Prepaid Discount %", "Cowork Prepaid Left", "Cowork Prepaid Rate", "Cowork Prepaid Used",
    "Cowork Total Cost", "Cowork Weekly Cost", "Cowork Weekly PAYG Cost", "Cowork Weekly Prepaid Cost",
    "Dormant Seat $", "Effective Cost", "Month Cost $", "Over Limit $", "Over Limit $ (Individual)",
    "Projected Cost (30d)", "Projected Cost (Horizon)", "Projected Cost by Agent (12mo)",
    "Projected Cost by Agent (30d)", "Projected Cost by Group (12mo)", "Projected Cost by Group (30d)",
    "Rates In Use", "Reclaimable $", "Reporting Cowork Cost", "Reporting Product Cost",
    "Reporting Studio Cost", "Right-Size Net $", "Savings vs List", "Studio Cost /mo",
    "Studio Effective Rate", "Studio Forecast Summary", "Studio Month Cost", "Studio PAYG Cost",
    "Studio Prepaid Cost", "Studio Prepaid Discount %", "Studio Year Cost", "Total Billable Cost",
    "Unattributed Cost Note", "Under-Utilized $", "Ungoverned $", "Year Cost $",
];

const definedNames = (query: string) =>
    Array.from(query.matchAll(/MEASURE\s+'(?:[^']|'')*'\[([^\]]+)\]/g), (match) => match[1]);

const ALL = { creditRate: 0.012, prepaidCreditRate: 0.0074, prepaidCreditBalance: 100000 };

describe("withCommercialTerms", () => {
    it("returns the query untouched when no term is set", () => {
        const query = queries["./cowork-credits-summary.dax"];
        expect(withCommercialTerms(query, undefined)).toBe(query);
        expect(withCommercialTerms(query, {})).toBe(query);
    });

    it("returns the query untouched when it shows no cost", () => {
        const query = queries["./consumption-dates.dax"];
        expect(withCommercialTerms(query, ALL)).toBe(query);
    });

    it("redefines every measure between a cost and the rates, and the rates themselves", () => {
        const names = definedNames(withCommercialTerms(`EVALUATE ROW("Cost", [Cowork Total Cost])`, ALL));
        expect(names.sort()).toEqual(
            [
                "Cowork PAYG Rate Value",
                "Studio PAYG Rate Value",
                "Cowork Prepaid Rate Value",
                "Studio Prepaid Rate Value",
                "Cowork Capacity Pack Balance Value",
                "Cowork Total Cost",
                "Cowork PAYG Cost",
                "Cowork PAYG Credits",
                "Cowork PAYG Rate",
                "Cowork Prepaid Balance",
                "Cowork Prepaid Cost",
                "Cowork Prepaid Used",
            ].sort(),
        );
    });

    it("redefines only the measures the set terms reach", () => {
        const names = definedNames(
            withCommercialTerms(`EVALUATE ROW("Cost", [Cowork Total Cost])`, { prepaidCreditBalance: 50000 }),
        );
        expect(names).toContain("Cowork Capacity Pack Balance Value");
        expect(names).toContain("Cowork PAYG Credits");
        expect(names).not.toContain("Cowork PAYG Rate Value");
        expect(names).not.toContain("Cowork PAYG Rate");
    });

    it("writes the terms as plain numbers", () => {
        const query = withCommercialTerms(`EVALUATE ROW("Cost", [Total Billable Cost])`, {
            creditRate: 0.000005,
            prepaidCreditRate: 0.0074,
        });
        expect(query).toContain("MEASURE 'Settings'[Studio PAYG Rate Value] = 0.000005");
        expect(query).toContain("MEASURE 'Settings'[Studio Prepaid Rate Value] = 0.0074");
        expect(query).not.toMatch(/\de-\d/);
    });

    it("joins a query's own DEFINE rather than adding a second", () => {
        const query = withCommercialTerms(queries["./cowork-credits-summary.dax"], ALL);
        expect(query.match(/^\s*DEFINE\b/gm)).toHaveLength(1);
        expect(definedNames(query)).toContain("ValueLens Cowork Policies");
        expect(definedNames(query)).toContain("Billing Basis");
        expect(query.indexOf("Billing Basis")).toBeLessThan(query.indexOf("EVALUATE"));
    });

    it("starts a DEFINE when the query has none", () => {
        const query = withCommercialTerms(queries["./studio-daily.dax"], ALL);
        expect(query.trimStart().startsWith("DEFINE")).toBe(true);
        expect(query.match(/\bDEFINE\b/g)).toHaveLength(1);
    });

    it("leaves a measure the query defines itself alone", () => {
        const own = `DEFINE\n    MEASURE 'CoworkBilling'[Cowork PAYG Rate] = 1\nEVALUATE ROW("Cost", [Cowork PAYG Cost])`;
        const names = definedNames(withCommercialTerms(own, ALL));
        expect(names.filter((name) => name === "Cowork PAYG Rate")).toHaveLength(1);
        expect(names).toContain("Cowork PAYG Cost");
    });

    it("redefines every rate-dependent measure any Consumption query reaches", () => {
        const chain = new Set(RATE_MEASURES.map((measure) => measure.name));
        for (const [file, query] of Object.entries(queries)) {
            const reached = RATE_DEPENDENT.filter((name) => query.includes(`[${name}]`));
            for (const name of reached) expect(chain.has(name), `${file} reads [${name}]`).toBe(true);
            if (reached.length > 0) expect(definedNames(withCommercialTerms(query, ALL)), file).toEqual(expect.arrayContaining(reached));
        }
    });

    it("reads the model's own terms from its rate inputs", () => {
        const { query } = modelCommercialTerms();
        expect(query).toContain("[Cowork PAYG Rate Value]");
        expect(query).toContain("[Cowork Prepaid Rate Value]");
        expect(query).toContain("[Cowork Capacity Pack Balance Value]");
    });
});

describe("hasCommercialTerms", () => {
    it("is true once any term is set", () => {
        expect(hasCommercialTerms(undefined)).toBe(false);
        expect(hasCommercialTerms({})).toBe(false);
        expect(hasCommercialTerms({ prepaidCreditBalance: 0 })).toBe(true);
    });
});

describe("readsCommercialTerms", () => {
    it("is true only for queries that show a cost or a rate", () => {
        expect(readsCommercialTerms(queries["./cowork-credits-summary.dax"])).toBe(true);
        expect(readsCommercialTerms(queries["./commercial-terms.dax"])).toBe(true);
        expect(readsCommercialTerms(queries["./consumption-options.dax"])).toBe(false);
        expect(readsCommercialTerms(queries["./consumption-dates.dax"])).toBe(false);
    });
});

describe("daxNumber", () => {
    it("keeps whole numbers whole and trims decimals", () => {
        expect(daxNumber(100000)).toBe("100000");
        expect(daxNumber(1e21)).toBe("1000000000000000000000");
        expect(daxNumber(0.0085)).toBe("0.0085");
        expect(daxNumber(0.01)).toBe("0.01");
    });

    it("refuses what DAX cannot read", () => {
        expect(() => daxNumber(Number.NaN)).toThrow();
        expect(() => daxNumber(Number.POSITIVE_INFINITY)).toThrow();
    });
});

describe("parseTerm and validateTerm", () => {
    it("reads typed values", () => {
        expect(parseTerm("")).toBeUndefined();
        expect(parseTerm("  ")).toBeUndefined();
        expect(parseTerm("$0.0085")).toBe(0.0085);
        expect(parseTerm(".01")).toBe(0.01);
        expect(parseTerm("100,000")).toBe(100000);
        expect(parseTerm("1e5")).toBeNaN();
        expect(parseTerm("-1")).toBeNaN();
        expect(parseTerm("ten")).toBeNaN();
    });

    it("accepts the rates the notebook accepts", () => {
        expect(validateTerm("creditRate", undefined)).toBeUndefined();
        expect(validateTerm("creditRate", 0.01)).toBeUndefined();
        expect(validateTerm("prepaidCreditRate", 0.001)).toBeUndefined();
        expect(validateTerm("creditRate", 0.05)).toBeUndefined();
        expect(validateTerm("creditRate", 1)).toMatch(/between/);
        expect(validateTerm("creditRate", 0.0001)).toMatch(/between/);
        expect(validateTerm("creditRate", Number.NaN)).toMatch(/number/);
    });

    it("accepts whole, non-negative pack balances", () => {
        expect(validateTerm("prepaidCreditBalance", 0)).toBeUndefined();
        expect(validateTerm("prepaidCreditBalance", 250000)).toBeUndefined();
        expect(validateTerm("prepaidCreditBalance", -5)).toMatch(/zero or more/);
        expect(validateTerm("prepaidCreditBalance", 10.5)).toMatch(/whole/);
    });
});
