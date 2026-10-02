//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CommercialTermsProvider } from "@/components/commercial-terms-provider";
import { ValueAssumptionsProvider } from "@/components/value-assumptions-provider";
import { CONSUMPTION_CONFIGURED } from "./cost-vs-value-data";
import { CostVsValueStage } from "./cost-vs-value-stage";
import { SurfacesStage } from "./surfaces-stage";
import { TasksStage } from "./tasks-stage";
import { EstimatedValueStage } from "./estimated-value-stage";

/**
 * What the work was, read top to bottom: how much got done and what kind,
 * where it happened, what that recorded work would have cost under an
 * explicit rate and effort scenario, and how that sets against what Copilot
 * cost. The last two stages share one rate and scenario.
 */
export function ValueScreen() {
    return (
        <CommercialTermsProvider readModel={CONSUMPTION_CONFIGURED}>
            <ValueAssumptionsProvider>
                <div className="flex flex-col gap-800">
                    <TasksStage />
                    <SurfacesStage />
                    <EstimatedValueStage />
                    <CostVsValueStage />
                </div>
            </ValueAssumptionsProvider>
        </CommercialTermsProvider>
    );
}
