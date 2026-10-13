//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import { BUILT_IN_PACKS, type ReportPack } from "@/lib/report-pack";

export interface ReportPacksContextValue {
    /**
     * `loading` until the saved packs are known; `unavailable` when the app's
     * database couldn't be reached, so only the built-in packs are listed and
     * nothing can be saved.
     */
    status: "loading" | "ready" | "unavailable";
    unavailableReason?: string;
    /** The built-in packs, then the saved ones by name. */
    packs: readonly ReportPack[];
    /** Saves a pack for everyone, creating it when it is new; resolves to the stored pack. */
    save: (pack: ReportPack) => Promise<ReportPack>;
    remove: (id: string) => Promise<void>;
}

/** Without a provider, as in isolated component tests, only the built-in packs exist. */
export const ReportPacksContext = createContext<ReportPacksContextValue>({
    status: "ready",
    packs: BUILT_IN_PACKS,
    save: () => Promise.reject(new Error("Report packs can't be saved here.")),
    remove: () => Promise.reject(new Error("Report packs can't be deleted here.")),
});

export function useReportPacks(): ReportPacksContextValue {
    return useContext(ReportPacksContext);
}
