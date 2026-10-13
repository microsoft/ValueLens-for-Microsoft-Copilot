//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { CAUSAL_WORDS } from "@/lib/headline";
import {
    AZURE_BILLED_COST_HEADLINE,
    AZURE_BILLED_CREDITS_HEADLINE,
    BREAKDOWN_COST_HEADLINE,
    BREAKDOWN_CREDITS_HEADLINE,
    COWORK_COST_HEADLINE,
    COWORK_CREDITS_HEADLINE,
    PRODUCT_COST_CREDITS_ONLY,
    PRODUCT_COST_SAME_CURRENCY,
    STUDIO_COST_HEADLINE,
    STUDIO_CREDITS_HEADLINE,
} from "./headlines";

function table(columns: string[], rows: unknown[][]): DataTable {
    return { columns: columns.map((name) => ({ name, displayName: name })), rows } as unknown as DataTable;
}

const PRODUCT_COLUMNS = ["Product", "Product Sort", "Credits", "Cost", "Cost Basis", "Coverage"];

describe("product cost headline", () => {
    const products = table(PRODUCT_COLUMNS, [
        ["Microsoft 365 Copilot licences", 1, null, 9000, "List price", null],
        ["Copilot Studio", 2, 120000, 1200, "Credits", 0.4],
        ["Cowork / Work IQ", 3, 50000, 500, "Credits", 1],
        ["Azure Foundry", 4, null, 15000, "Azure", null],
    ]);

    it("compares every product's cost when they share a currency, without shares", () => {
        const text = PRODUCT_COST_SAME_CURRENCY(products);
        expect(text).toBe("Azure Foundry has the highest cost of the 4 products.");
        expect(text).not.toMatch(/%/);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("compares only the products priced in credits when Azure bills in another currency", () => {
        const text = PRODUCT_COST_CREDITS_ONLY(products);
        expect(text).toBe("Copilot Studio has the highest cost of the 2 products billed in credits.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no rows, one product, a tie or a negative cost", () => {
        expect(PRODUCT_COST_SAME_CURRENCY(table(PRODUCT_COLUMNS, []))).toBeUndefined();
        expect(PRODUCT_COST_SAME_CURRENCY(table(PRODUCT_COLUMNS, [["Copilot Studio", 2, 10, 100, "Credits", 1]]))).toBeUndefined();
        expect(
            PRODUCT_COST_SAME_CURRENCY(
                table(PRODUCT_COLUMNS, [
                    ["Copilot Studio", 2, 10, 100, "Credits", 1],
                    ["Cowork / Work IQ", 3, 10, 100, "Credits", 1],
                ]),
            ),
        ).toBeUndefined();
        expect(
            PRODUCT_COST_SAME_CURRENCY(
                table(PRODUCT_COLUMNS, [
                    ["Copilot Studio", 2, 10, 100, "Credits", 1],
                    ["Azure Foundry", 4, null, -5, "Azure", null],
                ]),
            ),
        ).toBeUndefined();
        expect(
            PRODUCT_COST_CREDITS_ONLY(
                table(PRODUCT_COLUMNS, [
                    ["Copilot Studio", 2, 10, 100, "Credits", 1],
                    ["Azure Foundry", 4, null, 900, "Azure", null],
                ]),
            ),
        ).toBeUndefined();
    });
});

const COWORK_COLUMNS = ["Week Index", "Week Start", "Credits", "Active Users", "Prepaid Cost", "PAYG Cost", "Credits WoW"];

describe("Cowork weekly headlines", () => {
    const weeks = table(COWORK_COLUMNS, [
        [1, "2026-04-26T00:00:00", 900, 40, 9, 0, null],
        [2, "2026-05-03T00:00:00", 1240, 52, 10, 2.4, 0.38],
        [3, "2026-05-10T00:00:00", 600, 31, null, null, -0.52],
    ]);

    it("gives the busiest week on the credits lens", () => {
        const text = COWORK_CREDITS_HEADLINE(weeks);
        expect(text).toBe(`Credits peaked in the week of 3 May 2026, at ${(1240).toLocaleString()}.`);
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("gives how much prepaid covers on the cost lens", () => {
        const text = COWORK_COST_HEADLINE(weeks);
        expect(text).toBe("Prepaid makes up 89% of the cost.");
        expect(text).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no weeks, a single week or no cost", () => {
        expect(COWORK_CREDITS_HEADLINE(table(COWORK_COLUMNS, []))).toBeUndefined();
        expect(COWORK_CREDITS_HEADLINE(table(COWORK_COLUMNS, [[1, "2026-05-03T00:00:00", 10, 1, 0, 0, null]]))).toBeUndefined();
        expect(COWORK_COST_HEADLINE(table(COWORK_COLUMNS, []))).toBeUndefined();
        expect(COWORK_COST_HEADLINE(table(COWORK_COLUMNS, [[1, "2026-05-03T00:00:00", 10, 1, 0, 0, null]]))).toBeUndefined();
    });
});

const STUDIO_COLUMNS = ["Usage Date", "Prepaid Credits", "PAYG Credits", "Credits", "Prepaid Cost", "PAYG Cost"];

describe("Copilot Studio daily headlines", () => {
    const days = table(STUDIO_COLUMNS, [
        ["2026-04-01T00:00:00", 3000, 0, 3000, 30, 0],
        ["2026-04-02T00:00:00", 1000, 4000, 5000, 10, 40],
    ]);

    it("follows the lens", () => {
        expect(STUDIO_CREDITS_HEADLINE(days)).toBe("Prepaid makes up 50% of credits.");
        expect(STUDIO_COST_HEADLINE(days)).toBe("Prepaid makes up 50% of the cost.");
        const payg = table(STUDIO_COLUMNS, [["2026-04-02T00:00:00", 0, 4000, 4000, 0, 40]]);
        expect(STUDIO_CREDITS_HEADLINE(payg)).toBe("Pay-as-you-go is all of credits.");
        expect(STUDIO_COST_HEADLINE(payg)).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing with no days or nothing consumed", () => {
        expect(STUDIO_CREDITS_HEADLINE(table(STUDIO_COLUMNS, []))).toBeUndefined();
        expect(STUDIO_COST_HEADLINE(table(STUDIO_COLUMNS, [["2026-04-02T00:00:00", 0, 0, 0, 0, 0]]))).toBeUndefined();
    });
});

const BREAKDOWN_COLUMNS = ["Breakdown", "Item", "Credits", "Cost"];

describe("Copilot Studio breakdown headlines", () => {
    const models = table(BREAKDOWN_COLUMNS, [
        ["Model", "GPT-4o", 6200, 62],
        ["Model", "GPT-4o mini", 2800, 28],
        ["Model", "o3", 1000, 10],
    ]);

    it("names the largest model on either lens", () => {
        expect(BREAKDOWN_CREDITS_HEADLINE(models)).toBe("GPT-4o is the largest, at 62% of credits.");
        expect(BREAKDOWN_COST_HEADLINE(models)).toBe("GPT-4o is the largest, at 62% of the estimated cost.");
        expect(BREAKDOWN_COST_HEADLINE(models)).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing for no rows, one item or a tie", () => {
        expect(BREAKDOWN_CREDITS_HEADLINE(table(BREAKDOWN_COLUMNS, []))).toBeUndefined();
        expect(BREAKDOWN_CREDITS_HEADLINE(table(BREAKDOWN_COLUMNS, [["Model", "GPT-4o", 10, 1]]))).toBeUndefined();
        expect(
            BREAKDOWN_COST_HEADLINE(
                table(BREAKDOWN_COLUMNS, [
                    ["Feature", "Classic answers", 10, 5],
                    ["Feature", "Generative answers", 10, 5],
                ]),
            ),
        ).toBeUndefined();
    });
});

const AZURE_COLUMNS = ["Usage Date", "Product", "Product Sort", "Cost", "Credits"];

describe("Azure billed headlines", () => {
    const days = table(AZURE_COLUMNS, [
        ["2026-04-01T00:00:00", "Copilot Studio", 2, 30, 3000],
        ["2026-04-02T00:00:00", "Copilot Studio", 2, 40, 4000],
        ["2026-04-02T00:00:00", "Cowork", 3, 30, 3000],
    ]);

    it("totals each product across the days", () => {
        expect(AZURE_BILLED_CREDITS_HEADLINE(days)).toBe(
            "Copilot Studio is the largest, at 70% of the pay-as-you-go credits billed in Azure.",
        );
        expect(AZURE_BILLED_COST_HEADLINE(days)).toBe("Copilot Studio is the largest, at 70% of the pay-as-you-go cost billed in Azure.");
        expect(AZURE_BILLED_COST_HEADLINE(days)).not.toMatch(CAUSAL_WORDS);
    });

    it("says nothing with no rows or one product", () => {
        expect(AZURE_BILLED_CREDITS_HEADLINE(table(AZURE_COLUMNS, []))).toBeUndefined();
        expect(AZURE_BILLED_COST_HEADLINE(table(AZURE_COLUMNS, [["2026-04-01T00:00:00", "Cowork", 3, 30, 3000]]))).toBeUndefined();
    });
});
