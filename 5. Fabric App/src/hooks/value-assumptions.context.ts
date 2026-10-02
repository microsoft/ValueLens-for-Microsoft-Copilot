//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext, useState } from "react";
import type { Scenario } from "@/queries/value/scenarios";

export { SCENARIOS, type Scenario } from "@/queries/value/scenarios";

/** The hourly rate the Value page starts at, in the model's currency. */
export const DEFAULT_HOURLY_RATE = 50;

export interface ValueAssumptions {
    /** What an hour of the recorded work is worth, in the model's currency. */
    rate: number;
    /** How much effort each task would have taken without Copilot. */
    scenario: Scenario;
    setRate: (rate: number) => void;
    setScenario: (scenario: Scenario) => void;
}

/**
 * The rate and scenario set on the Estimated value stage, shared with the
 * Cost vs value stage beneath it so both read the same assumptions.
 */
export const ValueAssumptionsContext = createContext<ValueAssumptions | null>(null);

/**
 * The Value page's shared assumptions. Without a provider, as in isolated
 * component tests, the caller keeps its own.
 */
export function useValueAssumptions(): ValueAssumptions {
    const shared = useContext(ValueAssumptionsContext);
    const [rate, setRate] = useState(DEFAULT_HOURLY_RATE);
    const [scenario, setScenario] = useState<Scenario>("Typical");
    return shared ?? { rate, scenario, setRate, setScenario };
}
