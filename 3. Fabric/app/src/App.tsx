//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { lazy, Suspense, useState } from "react";
import { AppShell } from "./components/app-shell";
import type { DestinationId } from "./components/destinations";
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
const ValueScreen = lazy(() => import("./screens/value").then((module) => ({ default: module.ValueScreen })));
const EfficiencyScreen = lazy(() =>
    import("./screens/efficiency").then((module) => ({ default: module.EfficiencyScreen })),
);

function App() {
    const [destination, setDestination] = useState<DestinationId>("adoption");

    return (
        <AppShell active={destination} onNavigate={setDestination}>
            <Suspense fallback={<QueryLoading />}>
                {destination === "adoption" && <AdoptionScreen />}
                {destination === "leaderboards" && <LeaderboardsScreen />}
                {destination === "readiness" && <ReadinessScreen />}
                {destination === "value" && <ValueScreen />}
                {destination === "efficiency" && <EfficiencyScreen />}
            </Suspense>
        </AppShell>
    );
}

export default App;
