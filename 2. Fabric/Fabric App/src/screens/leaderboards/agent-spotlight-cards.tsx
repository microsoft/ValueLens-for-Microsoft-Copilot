//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { toDataTable } from "@/lib/to-data-table";
import { agentFunctions, type AgentEntry } from "@/queries/agents";
import { agentSpotlights, readAgentFunctions } from "./agent-spotlights";

/**
 * Up to three small cards above the agent leaderboard: the most used agent,
 * the one used by the most job functions and the one reaching the most
 * organizations. The job functions card waits on its own query and is simply
 * left out while it loads, fails, or finds no functions.
 */
export function AgentSpotlightCards({ entries }: { entries: readonly AgentEntry[] }) {
    const source = agentFunctions();
    const result = useFilteredQuery(source);
    const functions = useMemo(
        () =>
            result.data?.status === "success"
                ? readAgentFunctions(toDataTable(result.data.table, source.columnMetadata))
                : [],
        [result.data, source.columnMetadata],
    );
    const cards = useMemo(() => agentSpotlights(entries, functions), [entries, functions]);

    if (cards.length === 0) return null;

    return (
        <ul aria-label="Agent spotlights" className="grid grid-cols-1 gap-400 md:grid-cols-3">
            {cards.map((card) => (
                <li key={card.id} className="flex flex-col gap-100 rounded-xl border border-border bg-card p-400">
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">{card.label}</span>
                    <span className="truncate text-[length:var(--text-500)] font-semibold leading-500 text-card-foreground" title={card.names}>
                        {card.names}
                    </span>
                    <span className="text-[length:var(--text-200)] leading-300 text-muted-foreground">{card.sentence}</span>
                </li>
            ))}
        </ul>
    );
}
