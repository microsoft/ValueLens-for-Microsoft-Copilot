//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDab } from "@/test/fake-dab";
import { COMMERCIAL_TERMS_ID, loadCommercialTerms, saveCommercialTerms } from "./commercial-terms.service";

let dab: FakeDab;

vi.mock("@/lib/rayfin-client", () => ({
    getRayfinClient: () => ({ data: dab.data }),
}));

/** Terms saved earlier from each admin form: rates, prices and budgets. */
const SAVED = {
    id: COMMERCIAL_TERMS_ID,
    creditRate: 0.01,
    prepaidCreditRate: 0.008,
    prepaidCreditBalance: 250000,
    licensePrice: 30,
    exchangeRate: 0.79,
    budgetCowork: 5000,
    budgetStudio: 2000,
    budgetAzure: 1000,
    currency: "GBP",
    updatedBy: "a@contoso.com",
    updatedAt: "2026-10-01T09:00:00.000Z",
};

beforeEach(() => {
    dab = new FakeDab();
});

describe("loadCommercialTerms", () => {
    it("reads every term saved", async () => {
        dab.seed("CommercialTerms", SAVED);
        await expect(loadCommercialTerms()).resolves.toEqual({
            creditRate: 0.01,
            prepaidCreditRate: 0.008,
            prepaidCreditBalance: 250000,
            licensePrice: 30,
            exchangeRate: 0.79,
            budgetCowork: 5000,
            budgetStudio: 2000,
            budgetAzure: 1000,
            currency: "GBP",
            updatedBy: "a@contoso.com",
            updatedAt: new Date("2026-10-01T09:00:00.000Z"),
        });
    });

    it("is null when nobody has saved any", async () => {
        await expect(loadCommercialTerms()).resolves.toBeNull();
    });
});

describe("saveCommercialTerms", () => {
    it("updates only the terms given, so terms saved elsewhere since are kept", async () => {
        dab.seed("CommercialTerms", SAVED);
        const upsert = vi.spyOn(dab.data.CommercialTerms, "upsert");
        await saveCommercialTerms({ licensePrice: 25, exchangeRate: 0.75 }, "b@contoso.com");
        const [where, create, update] = upsert.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>];
        expect(where).toEqual({ id: COMMERCIAL_TERMS_ID });
        expect(Object.keys(update).sort()).toEqual(["exchangeRate", "licensePrice", "updatedAt", "updatedBy"]);
        expect(update).toMatchObject({ licensePrice: 25, exchangeRate: 0.75, updatedBy: "b@contoso.com" });
        expect(create).toMatchObject({ id: COMMERCIAL_TERMS_ID, licensePrice: 25, exchangeRate: 0.75 });
        expect(create).not.toHaveProperty("creditRate");
        expect(dab.rows("CommercialTerms")).toEqual([
            { ...SAVED, licensePrice: 25, exchangeRate: 0.75, updatedBy: "b@contoso.com", updatedAt: expect.any(String) },
        ]);
    });

    it("returns every term, including those saved from the other forms", async () => {
        dab.seed("CommercialTerms", SAVED);
        await expect(saveCommercialTerms({ licensePrice: 25, exchangeRate: 0.75 }, "b@contoso.com")).resolves.toMatchObject({
            creditRate: 0.01,
            prepaidCreditRate: 0.008,
            prepaidCreditBalance: 250000,
            licensePrice: 25,
            exchangeRate: 0.75,
            budgetCowork: 5000,
            budgetStudio: 2000,
            budgetAzure: 1000,
            currency: "GBP",
            updatedBy: "b@contoso.com",
        });
    });

    it("creates the row the first time, with only the terms given", async () => {
        const saved = await saveCommercialTerms({ budgetCowork: 5000 }, "a@contoso.com");
        expect(dab.rows("CommercialTerms")).toEqual([
            expect.objectContaining({ id: COMMERCIAL_TERMS_ID, budgetCowork: 5000, creditRate: null, updatedBy: "a@contoso.com" }),
        ]);
        expect(saved).toMatchObject({ budgetCowork: 5000, updatedBy: "a@contoso.com" });
        expect(saved.creditRate).toBeUndefined();
    });

    it("clears a term given as undefined, so its default applies again", async () => {
        dab.seed("CommercialTerms", SAVED);
        const upsert = vi.spyOn(dab.data.CommercialTerms, "upsert");
        const saved = await saveCommercialTerms({ creditRate: undefined }, undefined);
        const update = upsert.mock.calls[0][2] as unknown as Record<string, unknown>;
        expect(update.creditRate).toBeNull();
        expect(update.updatedBy).toBeNull();
        expect(update).not.toHaveProperty("licensePrice");
        expect(saved.creditRate).toBeUndefined();
        expect(saved.licensePrice).toBe(30);
    });

    it("reads back the saved row", async () => {
        const saved = await saveCommercialTerms({ prepaidCreditRate: 0.008 }, "a@contoso.com");
        expect(saved.prepaidCreditRate).toBe(0.008);
        expect(saved.updatedBy).toBe("a@contoso.com");
        expect(saved.updatedAt).toBeInstanceOf(Date);
    });
});
