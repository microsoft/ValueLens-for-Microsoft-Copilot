//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ShieldAlert } from "lucide-react";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { readNumber } from "@/lib/summary-row";
import { BODY } from "@/lib/type-scale";
import { RESOURCE_GRAPH_NO_DATA, RESOURCE_GRAPH_NOT_SET_UP } from "@/queries/governance";
import type { ResourceGraphSummary } from "./resource-graph-summary";

function Notes({ notes }: { notes: readonly string[] }) {
    return notes.map((note) => (
        <p key={note} className={`flex max-w-[80ch] items-start gap-200 ${BODY} text-muted-foreground`}>
            <ShieldAlert className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
            {note}
        </p>
    ));
}

/**
 * Agent configuration and Foundry exposure from Azure Resource Graph: agents
 * anyone can use without signing in or that search the web, and Foundry
 * resources open to the public network. Says plainly when the source is off
 * or the load's identity lacks a role, rather than showing zeroes.
 */
export function ResourceGraphPanel({ summary, className }: { summary: ResourceGraphSummary; className?: string }) {
    const { result, view } = summary;
    const row = result.row;
    switch (view.kind) {
        case "loading":
            return <QueryLoading />;
        case "notSetUp":
            return <QueryEmpty {...RESOURCE_GRAPH_NOT_SET_UP} />;
        case "error":
            return <QueryError message={view.message} onRetry={result.refetch} />;
        case "noData":
            return (
                <>
                    <QueryEmpty {...RESOURCE_GRAPH_NO_DATA} />
                    <Notes notes={view.notes} />
                </>
            );
        case "ready": {
            const agentValue = (column: string) => (view.agents ? readNumber(row, column) : undefined);
            const foundryValue = (column: string) => (view.foundry ? readNumber(row, column) : undefined);
            return (
                <>
                    <div className={className}>
                        <KpiCard
                            label="No sign-in required"
                            value={agentValue("[No Sign In]")}
                            emptyValue="Not read"
                            emphasis
                            detail={
                                <KpiStat label="Any agent, live or not" value={agentValue("[No Sign In Configured]")} />
                            }
                        />
                        <KpiCard
                            label="Web search on"
                            value={agentValue("[Web Search]")}
                            emptyValue="Not read"
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat label="Agents configured" value={agentValue("[Configured Agents]")} />
                                    <KpiStat label="Matched to the registry" value={agentValue("[Matched Agents]")} />
                                </div>
                            }
                        />
                        <KpiCard
                            label="Foundry open to the public network"
                            value={foundryValue("[Foundry Public]")}
                            emptyValue="Not read"
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat label="Foundry resources" value={foundryValue("[Foundry Resources]")} />
                                    <KpiStat label="Projects among them" value={foundryValue("[Foundry Public Projects]")} />
                                </div>
                            }
                        />
                    </div>
                    <Notes notes={view.notes} />
                </>
            );
        }
    }
}
