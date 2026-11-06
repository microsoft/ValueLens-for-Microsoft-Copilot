//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthContext } from "@/hooks/auth.context";
import { TaskTimesContext, type TaskTimesContextValue } from "@/hooks/task-times.context";
import {
    loadTaskTimes,
    saveTaskTimes,
    type SavedTaskTime,
    type TaskTimeChange,
} from "@/services/task-times.service";

type LoadState =
    | { status: "loading" }
    | { status: "ready"; saved: SavedTaskTime[] }
    | { status: "unavailable"; reason: string };

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Reads the task times saved in the app once, for every page: they change
 * the hours, and so the value, wherever the app shows them.
 */
export function TaskTimesProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const auth = useContext(AuthContext);
    const email = auth?.session?.user?.email;

    useEffect(() => {
        let cancelled = false;
        loadTaskTimes().then(
            (saved) => !cancelled && setState({ status: "ready", saved }),
            (error: unknown) => !cancelled && setState({ status: "unavailable", reason: describe(error) }),
        );
        return () => {
            cancelled = true;
        };
    }, []);

    const save = useCallback(
        async (changes: readonly TaskTimeChange[]) => {
            try {
                const saved = await saveTaskTimes(changes, email);
                setState({ status: "ready", saved });
            } catch (error) {
                // Some changes may have landed; show what the database now holds.
                await loadTaskTimes().then(
                    (saved) => setState({ status: "ready", saved }),
                    () => undefined,
                );
                throw error;
            }
        },
        [email],
    );

    const value = useMemo<TaskTimesContextValue>(
        () => ({
            status: state.status,
            unavailableReason: state.status === "unavailable" ? state.reason : undefined,
            saved: state.status === "ready" ? state.saved : [],
            save,
        }),
        [state, save],
    );

    return <TaskTimesContext.Provider value={value}>{children}</TaskTimesContext.Provider>;
}
