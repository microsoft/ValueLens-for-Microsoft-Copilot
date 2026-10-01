//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthContext } from "@/hooks/auth.context";
import { CommercialTermsContext, type CommercialTermsContextValue } from "@/hooks/commercial-terms.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { modelCommercialTerms, type CommercialTermsValues } from "@/queries/consumption/commercial-terms";
import {
    loadCommercialTerms,
    saveCommercialTerms,
    type SavedCommercialTerms,
} from "@/services/commercial-terms.service";

type LoadState =
    | { status: "loading" }
    | { status: "ready"; saved: SavedCommercialTerms | null }
    | { status: "unavailable"; reason: string };

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Reads the terms saved in the app once, and the model's own beside them,
 * for the Consumption page's costs and its rates control.
 */
export function CommercialTermsProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const auth = useContext(AuthContext);
    const email = auth?.session?.user?.email;

    useEffect(() => {
        let cancelled = false;
        loadCommercialTerms().then(
            (saved) => !cancelled && setState({ status: "ready", saved }),
            (error: unknown) => !cancelled && setState({ status: "unavailable", reason: describe(error) }),
        );
        return () => {
            cancelled = true;
        };
    }, []);

    const modelSource = modelCommercialTerms();
    const modelResult = useSemanticModelQuery({ connection: modelSource.connection, query: modelSource.query });
    const model = useMemo<CommercialTermsValues | undefined>(() => {
        if (modelResult.data?.status !== "success") return undefined;
        const row = toSummaryRow(modelResult.data.table);
        return {
            creditRate: readNumber(row, "[Credit Rate]"),
            prepaidCreditRate: readNumber(row, "[Prepaid Credit Rate]"),
            prepaidCreditBalance: readNumber(row, "[Prepaid Credit Balance]"),
        };
    }, [modelResult.data]);

    const save = useCallback(
        async (values: CommercialTermsValues) => {
            const saved = await saveCommercialTerms(values, email);
            setState({ status: "ready", saved });
        },
        [email],
    );

    const value = useMemo<CommercialTermsContextValue>(
        () => ({
            status: state.status,
            unavailableReason: state.status === "unavailable" ? state.reason : undefined,
            saved: state.status === "ready" ? state.saved : null,
            model,
            save,
        }),
        [state, model, save],
    );

    return <CommercialTermsContext.Provider value={value}>{children}</CommercialTermsContext.Provider>;
}
