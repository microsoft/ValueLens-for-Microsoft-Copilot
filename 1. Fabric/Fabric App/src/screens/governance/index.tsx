//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useSummaryQuery } from "@/hooks/use-table-query";
import { governanceSummary } from "@/queries/governance";
import { AccountabilityStage } from "./accountability-stage";
import { EstateHealthStage } from "./estate-health-stage";
import { ExposureStage } from "./exposure-stage";
import { ReviewQueueStage } from "./review-queue-stage";

const SUMMARY = governanceSummary();

/**
 * The Agent 365 registry read as an estate to look after: how big it is and
 * how much of it needs a review, who can reach each agent against what it
 * can read, whether someone is still accountable for it, and the agents to
 * sort out first. The registry is a catalogue rather than activity, so only
 * the agent-type filter applies.
 */
export function GovernanceScreen() {
    const summary = useSummaryQuery(SUMMARY);

    return (
        <div className="flex flex-col gap-800">
            <EstateHealthStage summary={summary} />
            <ExposureStage />
            <AccountabilityStage summary={summary} />
            <ReviewQueueStage />
        </div>
    );
}
