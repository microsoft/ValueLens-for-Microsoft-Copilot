//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { QueryError, QueryLoading } from "@/components/query-states";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { toDataTable } from "@/lib/to-data-table";
import { agentFunctions } from "@/queries/agents";
import { agentSpotlights, readAgentFunctions, readRegistrySpotlights } from "./agent-spotlights";

/**
 * Up to three small cards above the agent leaderboard: the most used agent,
 * the one used by the most job functions and the one reaching the most
 * organizations. Whole-population summaries are independent of the list cap.
 */
export function AgentSpotlightCards({ table }: { table: DataTable | undefined }) {
    const source = agentFunctions();
    const result = useFilteredQuery(source);
    const functions = useMemo(
        () =>
            result.data?.status === "success"
                ? readAgentFunctions(toDataTable(result.data.table, source.columnMetadata))
                : [],
        [result.data, source.columnMetadata],
    );
    const summary = useMemo(() => readRegistrySpotlights(table), [table]);
    const cards = useMemo(() => agentSpotlights([], functions, summary), [summary, functions]);
    const incomplete = !summary.sessions || !summary.orgs;
    const missingFunctions = result.data?.status === "success" && result.data.table.rows.length > 0 && functions.length === 0;

    return (
        <ul aria-label="Agent spotlights" className="grid grid-cols-1 gap-400 md:grid-cols-3">
            {incomplete && <li><p className="text-[length:var(--text-200)] text-muted-foreground">Agent spotlight totals are unavailable. Winners cannot be inferred from the limited list.</p></li>}
            {cards.map((card) => (
                <li key={card.id} className="flex flex-col gap-100 rounded-xl border border-border bg-card p-400">
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">{card.label}</span>
                    <span className="truncate text-[length:var(--text-500)] font-semibold leading-500 text-card-foreground" title={card.names}>
                        {card.headline}
                    </span>
                    <span className="text-[length:var(--text-200)] leading-300 text-muted-foreground">{card.sentence}</span>
                </li>
            ))}
            {result.data?.status === "error" ? (
                <li><QueryError message={result.data.error.message} onRetry={result.refetch} /></li>
            ) : result.isLoading || !result.data ? (
                <li><QueryLoading /></li>
            ) : missingFunctions ? (
                <li><QueryError message="The job-function spotlight count is incomplete. Retry to load the full result." onRetry={result.refetch} /></li>
            ) : null}
        </ul>
    );
}
