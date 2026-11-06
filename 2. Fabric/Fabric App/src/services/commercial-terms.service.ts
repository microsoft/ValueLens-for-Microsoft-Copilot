//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { getSettingsStore, COMMERCIAL_TERMS_ID, type SavedCommercialTerms } from "@/lib/settings-store";
import type { CommercialTermsValues } from "@/queries/consumption/commercial-terms";

export { COMMERCIAL_TERMS_ID, type SavedCommercialTerms };

/** The terms saved in the app, or null when nobody has saved any. */
export function loadCommercialTerms(): Promise<SavedCommercialTerms | null> {
    return getSettingsStore().loadCommercialTerms();
}

/** Saves the terms in `patch` for everyone and leaves the rest as they are. */
export function saveCommercialTerms(
    patch: CommercialTermsValues,
    updatedBy: string | undefined,
): Promise<SavedCommercialTerms> {
    return getSettingsStore().saveCommercialTerms(patch, updatedBy);
}