//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Suspense, useMemo, useState } from "react";
import { AppShell, type AppView } from "./components/app-shell";
import {
    availableDestinations,
    destinations,
    isBandDestination,
    openStage,
    type DestinationId,
    type StageId,
} from "./components/destinations";
import { FilterProvider } from "./components/filter-provider";
import { Prefetcher } from "./components/prefetcher";
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
import { SCREENS } from "./screens/registry";

type Selection = { kind: "destination"; id: DestinationId; stage?: StageId } | { kind: "pack"; id: string };

/**
 * The open destination and stage, or report pack, its slicers and the shell
 * around it. The app opens on the first page this install has: the
 * Executive summary with ValueLens, Consumption without it. A page whose
 * source turns out to have no data, or a pack that has been deleted, gives
 * way to that first page.
 */
function Workspace() {
    const sources = useSourceAvailability();
    const { packs } = useReportPacks();
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);
    const home: DestinationId = (available.find((candidate) => !isBandDestination(candidate)) ?? available[0])?.id ?? "executive";
    const [selected, setSelected] = useState<Selection>(() => ({ kind: "destination", id: home }));

    const view = useMemo<AppView>(() => {
        if (selected.kind === "pack") {
            const pack = packs.find(({ id }) => id === selected.id);
            if (pack) return { kind: "pack", pack, ...packRuns(pack.stages, available) };
        }
        const destination = selected.kind === "destination" ? available.find((candidate) => candidate.id === selected.id) : undefined;
        const id = destination?.id ?? home;
        const stage = destination && selected.kind === "destination" ? selected.stage : undefined;
        return { kind: "destination", id, stage: openStage(destinations.find((candidate) => candidate.id === id)!, stage) };
    }, [selected, packs, available, home]);

    const applicable = useMemo(
        () =>
            view.kind === "pack"
                ? packFilters(view.runs)
                : (destinations.find((candidate) => candidate.id === view.id)?.filters ?? []),
        [view],
    );

    const navigation = useMemo(
        () => ({
            navigate: (id: DestinationId, stage?: StageId) => setSelected({ kind: "destination", id, stage }),
        }),
        [],
    );
    const openPack = (id: string) => setSelected({ kind: "pack", id });

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
                {/* Outside the shell, so a page fetched ahead never lands in a download. */}
                <Prefetcher
                    available={available}
                    current={view.kind === "destination" ? view.id : undefined}
                    stage={view.kind === "destination" ? view.stage : undefined}
                    screens={SCREENS}
                />
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
