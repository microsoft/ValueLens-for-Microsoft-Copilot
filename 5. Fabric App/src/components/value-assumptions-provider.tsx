//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import {
    DEFAULT_HOURLY_RATE,
    ValueAssumptionsContext,
    type Scenario,
    type ValueAssumptions,
} from "@/hooks/value-assumptions.context";

/** Holds the Value page's hourly rate and effort scenario for every stage on it. */
export function ValueAssumptionsProvider({ children }: { children: ReactNode }) {
    const [rate, setRate] = useState(DEFAULT_HOURLY_RATE);
    const [scenario, setScenario] = useState<Scenario>("Typical");
    const value = useMemo<ValueAssumptions>(() => ({ rate, scenario, setRate, setScenario }), [rate, scenario]);
    return <ValueAssumptionsContext.Provider value={value}>{children}</ValueAssumptionsContext.Provider>;
}
