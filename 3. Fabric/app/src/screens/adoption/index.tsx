//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ActivationStage } from "./activation-stage";
import { AdoptionStage } from "./adoption-stage";
import { HabitStage } from "./habit-stage";
import { TrendHeatmapStage } from "./trend-heatmap-stage";

/**
 * The adoption funnel, read top to bottom: did people start, do they come
 * back, has it become a habit, and where is that momentum concentrating.
 * Four report pages, more than one hundred visuals and eight queries.
 */
export function AdoptionScreen() {
    return (
        <div className="flex flex-col gap-800">
            <ActivationStage />
            <AdoptionStage />
            <HabitStage />
            <TrendHeatmapStage />
        </div>
    );
}
