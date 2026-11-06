//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommercialTermsContext } from "@/hooks/commercial-terms.context";
import type { SavedCommercialTerms } from "@/services/commercial-terms.service";
import { TermsForm, type TermField, type TermsCurrency } from "./terms-form";

const fields: TermField[] = [
    { key: "licensePrice", label: "Licence", hint: "$ per user per month.", inputMode: "decimal" },
    {
        key: "exchangeRate",
        label: (currency) => `${currency} per $1`,
        hint: "Per dollar.",
        inputMode: "decimal",
        showWhen: (currency) => currency !== "USD",
    },
];

function renderForm(saved: SavedCommercialTerms | null, currency: TermsCurrency) {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
        <CommercialTermsContext.Provider value={{ status: "ready", saved, model: undefined, save }}>
            <TermsForm
                fields={fields}
                currency={currency}
                intro="Intro."
                resetLabel="Use defaults"
                unavailableText="Unavailable."
                note="Note."
                close={() => {}}
            />
        </CommercialTermsContext.Provider>,
    );
    return save;
}

describe("TermsForm reporting currency", () => {
    it("hides the exchange rate for US dollars and clears it on save", async () => {
        const save = renderForm({ exchangeRate: 0.8, currency: "USD" }, { value: "USD", choose: true });
        expect(screen.queryByLabelText("USD per $1")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        await waitFor(() => expect(save).toHaveBeenCalled());
        expect(save.mock.calls[0][0]).toMatchObject({ currency: "USD", exchangeRate: undefined });
    });

    it("asks for a fresh rate when the currency changes, and saves the two together", async () => {
        const save = renderForm({ exchangeRate: 0.79, currency: "GBP" }, { value: "GBP", choose: true });
        expect(screen.getByLabelText("GBP per $1")).toHaveValue("0.79");

        fireEvent.change(screen.getByLabelText("Reporting currency"), { target: { value: "EUR" } });
        const rate = screen.getByLabelText("EUR per $1");
        expect(rate).toHaveValue("");
        fireEvent.change(rate, { target: { value: "0.92" } });
        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        await waitFor(() => expect(save).toHaveBeenCalled());
        expect(save.mock.calls[0][0]).toMatchObject({ currency: "EUR", exchangeRate: 0.92 });
    });

    it("ties a rate typed without a picker to the page's currency", async () => {
        const save = renderForm(null, { value: "JPY", choose: false });
        expect(screen.queryByLabelText("Reporting currency")).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("JPY per $1"), { target: { value: "150" } });
        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        await waitFor(() => expect(save).toHaveBeenCalled());
        expect(save.mock.calls[0][0]).toMatchObject({ currency: "JPY", exchangeRate: 150 });
    });
});
