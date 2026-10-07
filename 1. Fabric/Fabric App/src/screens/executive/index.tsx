//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CommercialTermsProvider } from "@/components/commercial-terms-provider";
import { QueryEmpty, QueryError } from "@/components/query-states";
import { useFilterContext } from "@/hooks/filter.context";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import { AttentionStage } from "./attention-stage";
import { BottomLineStage } from "./bottom-line-stage";
import { GrowingStage } from "./growing-stage";
import { LandingStage } from "./landing-stage";
import { useExecutiveData } from "./use-executive-data";

function ExecutiveStages() {
    const data = useExecutiveData();
    const { optionsError } = useFilterContext();

    if (optionsError) {
        return <QueryError message={`The dates with Copilot activity couldn't be read: ${optionsError.message}`} />;
    }
    if (data.range.settled && !data.range.range) {
        return (
            <QueryEmpty
                title="No Copilot activity in this date range"
                description="Choose a date range that overlaps the days with Copilot activity. The summary covers only those days."
            />
        );
    }
    return (
        <div className="flex flex-col gap-800">
            <BottomLineStage data={data} />
            <GrowingStage data={data} />
            <LandingStage data={data} />
            <AttentionStage data={data} />
        </div>
    );
}

/**
 * The story on one page for a leader, read top to bottom: what Copilot
 * delivered and whether it is becoming how people work, whether that is
 * growing, where it is landing, and the decisions it points to. No figure
 * here is money; Cost vs value has that, one link away.
 */
export function ExecutiveScreen() {
    return (
        <CommercialTermsProvider readModel={CONSUMPTION_CONFIGURED}>
            <ExecutiveStages />
        </CommercialTermsProvider>
    );
}