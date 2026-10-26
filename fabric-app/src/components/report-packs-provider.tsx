//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthContext } from "@/hooks/auth.context";
import { ReportPacksContext, type ReportPacksContextValue } from "@/hooks/report-packs.context";
import { BUILT_IN_PACKS, type ReportPack } from "@/lib/report-pack";
import { getSettingsStore } from "@/lib/settings-store";

type LoadState =
    | { status: "loading" }
    | { status: "ready"; saved: ReportPack[] }
    | { status: "unavailable"; reason: string };

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function byName(packs: ReportPack[]): ReportPack[] {
    return packs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads the saved report packs once, for the sidebar and the Reports pages. */
export function ReportPacksProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const auth = useContext(AuthContext);
    const email = auth?.session?.user?.email;

    useEffect(() => {
        let cancelled = false;
        getSettingsStore()
            .loadReportPacks()
            .then(
                (saved) => !cancelled && setState({ status: "ready", saved }),
                (error: unknown) => !cancelled && setState({ status: "unavailable", reason: describe(error) }),
            );
        return () => {
            cancelled = true;
        };
    }, []);

    const save = useCallback(
        async (pack: ReportPack) => {
            const stored = await getSettingsStore().saveReportPack(pack, email);
            setState((current) => ({
                status: "ready",
                saved: byName([...(current.status === "ready" ? current.saved : []).filter((p) => p.id !== stored.id), stored]),
            }));
            return stored;
        },
        [email],
    );

    const remove = useCallback(async (id: string) => {
        await getSettingsStore().deleteReportPack(id);
        setState((current) =>
            current.status === "ready" ? { status: "ready", saved: current.saved.filter((p) => p.id !== id) } : current,
        );
    }, []);

    const value = useMemo<ReportPacksContextValue>(
        () => ({
            status: state.status,
            unavailableReason: state.status === "unavailable" ? state.reason : undefined,
            packs: [...BUILT_IN_PACKS, ...(state.status === "ready" ? state.saved : [])],
            save,
            remove,
        }),
        [state, save, remove],
    );

    return <ReportPacksContext.Provider value={value}>{children}</ReportPacksContext.Provider>;
}
