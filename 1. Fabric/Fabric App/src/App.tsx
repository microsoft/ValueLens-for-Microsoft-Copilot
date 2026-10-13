//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Suspense, useMemo, useRef, useState } from "react";
import { AppShell, type AppView } from "./components/app-shell";
import {
    availableDestinations,
    destinations,
    stageAnchor,
    type DestinationId,
    type StageId,
} from "./components/destinations";
import { FilterProvider } from "./components/filter-provider";
import { QueryLoading } from "./components/query-states";
import { ReportPackView } from "./components/report-pack-view";
import { ReportPacksProvider } from "./components/report-packs-provider";
import { TaskTimesProvider } from "./components/task-times-provider";
import { NavigationContext } from "./hooks/navigation.context";
import { useReportPacks } from "./hooks/report-packs.context";
import { SourceAvailabilityContext, useSourceAvailability } from "./hooks/source-availability.context";
import { useSourceProbes } from "./hooks/use-source-probes";
import { packFilters, packRuns } from "./lib/report-pack";
import { runtimeConfig } from "./lib/runtime-config";
import { scrollToAnchorWhenReady } from "./lib/scroll-to-anchor";
import { SCREENS } from "./screens/registry";

type Selection = { kind: "destination"; id: DestinationId } | { kind: "pack"; id: string };

/**
 * The open destination or report pack, its slicers and the shell around it.
 * A page whose source turns out to have no data, or a pack that has been
 * deleted, gives way to the Executive summary.
 */
function Workspace() {
    const [selected, setSelected] = useState<Selection>({ kind: "destination", id: "executive" });
    const sources = useSourceAvailability();
    const { packs } = useReportPacks();
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);

    const view = useMemo<AppView>(() => {
        if (selected.kind === "pack") {
            const pack = packs.find(({ id }) => id === selected.id);
            if (pack) return { kind: "pack", pack, ...packRuns(pack.stages, available) };
        }
        const id = selected.kind === "destination" && available.some((candidate) => candidate.id === selected.id) ? selected.id : "executive";
        return { kind: "destination", id };
    }, [selected, packs, available]);

    const applicable = useMemo(
        () =>
            view.kind === "pack"
                ? packFilters(view.runs)
                : (destinations.find((candidate) => candidate.id === view.id)?.filters ?? []),
        [view],
    );
    const stopWaiting = useRef<() => void>(undefined);

    const navigation = useMemo(
        () => ({
            navigate: (id: DestinationId, stage?: StageId) => {
                stopWaiting.current?.();
                setSelected({ kind: "destination", id });
                stopWaiting.current = stage ? scrollToAnchorWhenReady(stageAnchor(stage)) : undefined;
            },
        }),
        [],
    );
    const openPack = (id: string) => {
        stopWaiting.current?.();
        stopWaiting.current = undefined;
        setSelected({ kind: "pack", id });
    };

    const Screen = view.kind === "destination" ? SCREENS[view.id] : undefined;

    return (
        <FilterProvider applicable={applicable}>
            <NavigationContext.Provider value={navigation}>
                <AppShell view={view} onNavigate={navigation.navigate} onOpenPack={openPack}>
                    {view.kind === "pack" ? (
                        <ReportPackView key={view.pack.id} runs={view.runs} missing={view.missing} />
                    ) : (
                        Screen && (
                            // Screens load on demand so only the visible destination queries the model.
                            <Suspense fallback={<QueryLoading />}>
                                <Screen key={view.id} />
                            </Suspense>
                        )
                    )}
                </AppShell>
            </NavigationContext.Provider>
        </FilterProvider>
    );
}

function App() {
    const sources = useSourceProbes();
    return (
        <SourceAvailabilityContext.Provider value={sources}>
            <TaskTimesProvider>
                <ReportPacksProvider>
                    <Workspace />
                </ReportPacksProvider>
            </TaskTimesProvider>
        </SourceAvailabilityContext.Provider>
    );
}

export default App;
