//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { stageAnchor } from "@/components/destinations";
import { QueryError } from "@/components/query-states";
import { Section } from "@/components/section";
import { useTableQuery } from "@/hooks/use-table-query";
import { BODY } from "@/lib/type-scale";
import {
    evaluationFilters,
    evaluationOptions,
    NO_SELECTION,
    readEvaluationOptions,
    type EvaluationSelection,
} from "@/queries/agent-evaluation";
import { ConversationsStage } from "./conversations-stage";
import { EvaluationBar } from "./evaluation-bar";
import { PerformanceStage } from "./performance-stage";

const OPTIONS = evaluationOptions();

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
            <Section
                id={stageAnchor("agent-performance")}
                title="Agent Evaluation"
                description="This page reads the Agent Evaluator semantic model."
            >
                <p className={`${BODY} max-w-[68ch] text-muted-foreground`}>
                    Bind Agent Evaluator to this app as the <code className="font-mono">ae</code> connection, then
                    reload. Until it is bound, agent performance can't be shown.
                </p>
                <QueryError message={optionsResult.error} onRetry={optionsResult.refetch} />
            </Section>
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
