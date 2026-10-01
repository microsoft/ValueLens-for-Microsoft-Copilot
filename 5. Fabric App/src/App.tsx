//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { lazy, Suspense, useState } from "react";
import { AppShell } from "./components/app-shell";
import { destinations, type DestinationId } from "./components/destinations";
import { FilterProvider } from "./components/filter-provider";
import { QueryLoading } from "./components/query-states";

// Screens load on demand so only the visible destination queries the model.
const AdoptionScreen = lazy(() =>
    import("./screens/adoption").then((module) => ({ default: module.AdoptionScreen })),
);
const LeaderboardsScreen = lazy(() =>
    import("./screens/leaderboards").then((module) => ({ default: module.LeaderboardsScreen })),
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
const AppendixScreen = lazy(() =>
    import("./screens/appendix").then((module) => ({ default: module.AppendixScreen })),
);

function App() {
    const [destination, setDestination] = useState<DestinationId>("adoption");
    const applicable = destinations.find((candidate) => candidate.id === destination)?.filters ?? [];

    return (
        <FilterProvider applicable={applicable}>
            <AppShell active={destination} onNavigate={setDestination}>
                <Suspense fallback={<QueryLoading />}>
                    {destination === "adoption" && <AdoptionScreen />}
                    {destination === "leaderboards" && <LeaderboardsScreen />}
                    {destination === "readiness" && <ReadinessScreen />}
                    {destination === "consumption" && <ConsumptionScreen />}
                    {destination === "value" && <ValueScreen />}
                    {destination === "efficiency" && <EfficiencyScreen />}
                    {destination === "feedback" && <FeedbackScreen />}
                    {destination === "agent-evaluation" && <AgentEvaluationScreen />}
                    {destination === "appendix" && <AppendixScreen />}
                </Suspense>
            </AppShell>
        </FilterProvider>
    );
}

export default App;
