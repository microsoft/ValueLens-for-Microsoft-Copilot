//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ActivationStage } from "./activation-stage";
import { AdoptionStage } from "./adoption-stage";
import { HabitStage } from "./habit-stage";

/**
 * The adoption funnel, read top to bottom: did people start, do they come
 * back, and has it become a habit. Three report pages, ninety-three visuals
 * and six queries.
 */
export function AdoptionScreen() {
    return (
        <div className="flex flex-col gap-800">
            <ActivationStage />
            <AdoptionStage />
            <HabitStage />
        </div>
    );
}
