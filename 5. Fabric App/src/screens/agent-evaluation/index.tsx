//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { stageAnchor } from "@/components/destinations";
import { SourceEmpty, SourceError } from "@/components/source-states";
import { useTableQuery } from "@/hooks/use-table-query";
import {
    evaluationFilters,
    evaluationOptions,
    hasEvaluationData,
    NO_SELECTION,
    readEvaluationOptions,
    type EvaluationSelection,
} from "@/queries/agent-evaluation";
import { evaluatorConnection } from "@/queries/shared";
import { ConversationsStage } from "./conversations-stage";
import { EvaluationBar } from "./evaluation-bar";
import { PerformanceStage } from "./performance-stage";

const OPTIONS = evaluationOptions();
const SOURCE = { anchor: stageAnchor("agent-performance"), page: "Agent Evaluation", model: "Agent Evaluator" };

/**
 * The Agent Evaluator report's pages for Copilot Studio agents: how they
 * perform, then what people asked them and where answers came from. It reads
 * its own model, so it brings its own slicers rather than the filter bar's,
 * and it never shows what was said in a conversation.
 */
export function AgentEvaluationScreen() {
    const optionsResult = useTableQuery(OPTIONS);
    const options = useMemo(
        () => (optionsResult.table ? readEvaluationOptions(optionsResult.table) : undefined),
        [optionsResult.table],
    );
    const [selection, setSelection] = useState<EvaluationSelection>(NO_SELECTION);
    const extra = useMemo(() => evaluationFilters(selection, options), [selection, options]);

    if (optionsResult.error !== undefined) {
        return (
            <SourceError
                {...SOURCE}
                alias={evaluatorConnection}
                message={optionsResult.error}
                onRetry={optionsResult.refetch}
            />
        );
    }

    if (options && !hasEvaluationData(options)) {
        return (
            <SourceEmpty
                {...SOURCE}
                title="No agent conversations yet"
                description="Agent Evaluator is connected, but its model holds no Copilot Studio conversations. Once its lakehouse is loaded and the model refreshes, this page fills in."
            />
        );
    }

    return (
        <div className="flex flex-col gap-800">
            <EvaluationBar options={options} selection={selection} onChange={setSelection} />
            <PerformanceStage options={options} extra={extra} />
            <ConversationsStage extra={extra} />
        </div>
    );
}
