//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { ActivationStage } from "./activation-stage";
import { AdoptionStage } from "./adoption-stage";
import { HabitStage } from "./habit-stage";
import { TrendHeatmapStage } from "./trend-heatmap-stage";

/**
 * The adoption funnel: how many people use Copilot, did they start, do they
 * come back, has it become a habit, and where is that momentum concentrating.
 */
export function AdoptionScreen() {
    const { show } = useStageFilter();
    return (
        <div className="flex flex-col gap-800">
            {show("adoption") && <AdoptionStage />}
            {show("activation") && <ActivationStage />}
            {show("habit-formation") && <HabitStage />}
            {show("trend-heatmap") && <TrendHeatmapStage />}
        </div>
    );
}
