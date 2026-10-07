//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { AppShell } from "./components/app-shell";
import { destinations, stageAnchor, type DestinationId, type StageId } from "./components/destinations";
import { FilterProvider } from "./components/filter-provider";
import { QueryLoading } from "./components/query-states";
import { TaskTimesProvider } from "./components/task-times-provider";
import { NavigationContext } from "./hooks/navigation.context";
import { scrollToAnchorWhenReady } from "./lib/scroll-to-anchor";

// Screens load on demand so only the visible destination queries the model.
const ExecutiveScreen = lazy(() =>
    import("./screens/executive").then((module) => ({ default: module.ExecutiveScreen })),
);
const AdoptionScreen = lazy(() =>
    import("./screens/adoption").then((module) => ({ default: module.AdoptionScreen })),
);
const LeaderboardsScreen = lazy(() =>
    import("./screens/leaderboards").then((module) => ({ default: module.LeaderboardsScreen })),
);
const WorkPatternsScreen = lazy(() =>
    import("./screens/work-patterns").then((module) => ({ default: module.WorkPatternsScreen })),
);
const ReadinessScreen = lazy(() =>
    import("./screens/readiness").then((module) => ({ default: module.ReadinessScreen })),
);
const ConsumptionScreen = lazy(() =>
    import("./screens/consumption").then((module) => ({ default: module.ConsumptionScreen })),
);
const ValueScreen = lazy(() => import("./screens/value").then((module) => ({ default: module.ValueScreen })));
const EfficiencyScreen = lazy(() =>
    import("./screens/efficiency").then((module) => ({ default: module.EfficiencyScreen })),
);
const FeedbackScreen = lazy(() =>
    import("./screens/feedback").then((module) => ({ default: module.FeedbackScreen })),
);
const AgentEvaluationScreen = lazy(() =>
    import("./screens/agent-evaluation").then((module) => ({ default: module.AgentEvaluationScreen })),
);
const GovernanceScreen = lazy(() =>
    import("./screens/governance").then((module) => ({ default: module.GovernanceScreen })),
);
const AppendixScreen = lazy(() =>
    import("./screens/appendix").then((module) => ({ default: module.AppendixScreen })),
);
const AssumptionsScreen = lazy(() =>
    import("./screens/assumptions").then((module) => ({ default: module.AssumptionsScreen })),
);

function App() {
    const [destination, setDestination] = useState<DestinationId>("executive");
    const applicable = destinations.find((candidate) => candidate.id === destination)?.filters ?? [];
    const stopWaiting = useRef<() => void>(undefined);

    const navigation = useMemo(
        () => ({
            navigate: (id: DestinationId, stage?: StageId) => {
                stopWaiting.current?.();
                setDestination(id);
                stopWaiting.current = stage ? scrollToAnchorWhenReady(stageAnchor(stage)) : undefined;
            },
        }),
        [],
    );

    return (
        <TaskTimesProvider>
            <FilterProvider applicable={applicable}>
                <NavigationContext.Provider value={navigation}>
                    <AppShell active={destination} onNavigate={navigation.navigate}>
                        <Suspense fallback={<QueryLoading />}>
                            {destination === "executive" && <ExecutiveScreen />}
                            {destination === "adoption" && <AdoptionScreen />}
                            {destination === "leaderboards" && <LeaderboardsScreen />}
                            {destination === "work-patterns" && <WorkPatternsScreen />}
                            {destination === "readiness" && <ReadinessScreen />}
                            {destination === "consumption" && <ConsumptionScreen />}
                            {destination === "value" && <ValueScreen />}
                            {destination === "efficiency" && <EfficiencyScreen />}
                            {destination === "feedback" && <FeedbackScreen />}
                            {destination === "agent-evaluation" && <AgentEvaluationScreen />}
                            {destination === "governance" && <GovernanceScreen />}
                            {destination === "assumptions" && <AssumptionsScreen />}
                            {destination === "appendix" && <AppendixScreen />}
                        </Suspense>
                    </AppShell>
                </NavigationContext.Provider>
            </FilterProvider>
        </TaskTimesProvider>
    );
}

export default App;
