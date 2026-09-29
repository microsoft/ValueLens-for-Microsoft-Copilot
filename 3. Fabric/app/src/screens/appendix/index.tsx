//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { GlossaryStage } from "./glossary-stage";
import { SignalImpactStage } from "./signal-impact-stage";

/**
 * The report's two appendix pages as reference: the metric glossary, then the
 * signal-to-impact assumptions behind the value estimates. Neither reads
 * activity, so no filter applies.
 */
export function AppendixScreen() {
    return (
        <div className="flex flex-col gap-800">
            <GlossaryStage />
            <SignalImpactStage />
        </div>
    );
}
