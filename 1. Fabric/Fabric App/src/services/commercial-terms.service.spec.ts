//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCIAL_TERMS_ID, saveCommercialTerms } from "./commercial-terms.service";

const upsert = vi.fn();

vi.mock("@/lib/rayfin-client", () => ({
    getRayfinClient: () => ({ data: { CommercialTerms: { upsert } } }),
}));

describe("saveCommercialTerms", () => {
    beforeEach(() => {
        upsert.mockReset();
        upsert.mockImplementation((_where: unknown, create: Record<string, unknown>) => Promise.resolve(create));
    });

    it("updates only the terms given, so terms saved elsewhere since are kept", async () => {
        await saveCommercialTerms({ licensePrice: 25, exchangeRate: 0.75 }, "a@contoso.com");
        const [where, create, update] = upsert.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
        expect(where).toEqual({ id: COMMERCIAL_TERMS_ID });
        expect(Object.keys(update).sort()).toEqual(["exchangeRate", "licensePrice", "updatedAt", "updatedBy"]);
        expect(update).toMatchObject({ licensePrice: 25, exchangeRate: 0.75, updatedBy: "a@contoso.com" });
        expect(create).toMatchObject({ id: COMMERCIAL_TERMS_ID, licensePrice: 25, exchangeRate: 0.75 });
        expect(create).not.toHaveProperty("creditRate");
    });

    it("clears a term given as undefined, so its default applies again", async () => {
        await saveCommercialTerms({ creditRate: undefined }, undefined);
        const update = upsert.mock.calls[0][2] as Record<string, unknown>;
        expect(update.creditRate).toBeNull();
        expect(update.updatedBy).toBeNull();
        expect(update).not.toHaveProperty("licensePrice");
    });

    it("reads back the saved row", async () => {
        const saved = await saveCommercialTerms({ prepaidCreditRate: 0.008 }, "a@contoso.com");
        expect(saved.prepaidCreditRate).toBe(0.008);
        expect(saved.updatedBy).toBe("a@contoso.com");
        expect(saved.updatedAt).toBeInstanceOf(Date);
    });
});
