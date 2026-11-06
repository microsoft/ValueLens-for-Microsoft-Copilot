//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import type { CommercialTermsValues } from "@/queries/consumption/commercial-terms";
import type { SavedCommercialTerms } from "@/services/commercial-terms.service";

export interface CommercialTermsContextValue {
    /**
     * `loading` until the app's saved terms are known, so no cost is shown at
     * the wrong price first. `unavailable` when the app's database could not
     * be reached: costs then use the model's terms, and nothing can be saved.
     */
    status: "loading" | "ready" | "unavailable";
    /** Why the saved terms could not be read. */
    unavailableReason?: string;
    /** The terms saved in the app, applied to every cost on the page. */
    saved: SavedCommercialTerms | null;
    /** The model's own credit terms, before anything saved in the app. */
    model: CommercialTermsValues | undefined;
    /**
     * Saves the terms given for everyone and keeps the rest. A term given as
     * undefined goes back to its default: the model's, for a credit term.
     */
    save: (patch: CommercialTermsValues) => Promise<void>;
}

/**
 * The prices every cost on the Consumption page, and the cost side of the
 * Value page, is worked out at.
 *
 * Without a provider, as in isolated component tests, the model's own
 * terms apply and nothing waits.
 */
export const CommercialTermsContext = createContext<CommercialTermsContextValue>({
    status: "ready",
    saved: null,
    model: undefined,
    save: () => Promise.reject(new Error("Commercial terms can't be saved here.")),
});

export function useCommercialTerms(): CommercialTermsContextValue {
    return useContext(CommercialTermsContext);
}
