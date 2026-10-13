//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useStageFilter } from "@/hooks/stage-filter.context";
import { GlossaryStage } from "./glossary-stage";
import { SignalImpactStage } from "./signal-impact-stage";

/**
 * The report's two appendix pages as reference: the metric glossary, then the
 * signal-to-impact assumptions behind the value estimates. Neither reads
 * activity, so no filter applies.
 */
export function AppendixScreen() {
    const { show } = useStageFilter();
    return (
        <div className="flex flex-col gap-800">
            {show("glossary") && <GlossaryStage />}
            {show("signal-impact") && <SignalImpactStage />}
        </div>
    );
}
