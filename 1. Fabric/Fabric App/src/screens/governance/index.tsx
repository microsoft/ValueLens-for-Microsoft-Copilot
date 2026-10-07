//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { stageAnchor } from "@/components/destinations";
import { QueryEmpty } from "@/components/query-states";
import { Section } from "@/components/section";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useSummaryQuery } from "@/hooks/use-table-query";
import { isAbsent } from "@/lib/optional-sources";
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
 *
 * Every stage reads the registry, so once the app has found it empty the page
 * says how to connect it instead of running four sets of empty queries.
 */
export function GovernanceScreen() {
    const registry = !isAbsent(useSourceAvailability(), "agentRegistry");
    return registry ? <GovernanceStages /> : <ConnectRegistry />;
}

function GovernanceStages() {
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

function ConnectRegistry() {
    return (
        <Section
            id={stageAnchor("estate-health")}
            title="Governance"
            description="Who owns your agents, who can reach them, and what needs a review."
        >
            <QueryEmpty
                title="Connect the Agent 365 registry"
                description="Governance reads the Agent 365 registry, and the model has no registry data yet. Run the installer again with Agent 365 registry ticked (or run the registry ingester), let the next load finish, then reopen the app."
            />
        </Section>
    );
}
