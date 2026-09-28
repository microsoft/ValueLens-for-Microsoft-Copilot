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
const WorkScreen = lazy(() => import("./screens/work").then((module) => ({ default: module.WorkScreen })));

function App() {
    const [destination, setDestination] = useState<DestinationId>("adoption");

    return (
        <AppShell active={destination} onNavigate={setDestination}>
            <Suspense fallback={<QueryLoading />}>
                {destination === "adoption" && <AdoptionScreen />}
                {destination === "work" && <WorkScreen />}
            </Suspense>
        </AppShell>
    );
}

export default App;
