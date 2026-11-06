//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { CoworkFitStage } from "./cowork-fit-stage";
import { GradingMethodStage } from "./grading-method-stage";
import { ModelFitStage } from "./model-fit-stage";

/**
 * Whether the right tool and model are doing the job: Cowork fit first, then
 * the Model Fit page rebuilt as model-choice coverage and verdicts, then the
 * rules and research both stages grade by.
 */
export function EfficiencyScreen() {
    const { show } = useStageFilter();
    return (
        <div className="flex flex-col gap-800">
            {show("cowork-fit") && <CoworkFitStage />}
            {show("model-fit") && <ModelFitStage />}
            {show("grading-method") && <GradingMethodStage />}
        </div>
    );
}
