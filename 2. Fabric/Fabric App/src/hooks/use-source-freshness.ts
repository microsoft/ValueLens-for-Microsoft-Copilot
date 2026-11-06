//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useMemo } from "react";
import { isConnectionConfigured } from "@/lib/connections";
import type { FreshnessDates, FreshnessSource } from "@/lib/freshness";
import { isAbsent } from "@/lib/optional-sources";
import { runtimeConfig } from "@/lib/runtime-config";
import { toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import {
    auditLogFreshness,
    consumptionFreshness,
    evaluatorFreshness,
    m365ActivityFreshness,
    productFeedbackFreshness,
    registryFreshness,
} from "@/queries/freshness";
import { consumptionConnection, evaluatorConnection } from "@/queries/shared";
import { useSourceAvailability } from "./source-availability.context";
import { useSemanticModelQuery } from "./use-semantic-model-query";

/** Answers already read this session, by connection and query; null when the query failed. */
const answers = new Map<string, SummaryRow | null>();

/** Forgets the answers read so far. For tests. */
export function clearSourceFreshness(): void {
    answers.clear();
}

/**
 * One freshness query, run once a session and only when `wanted`. Unfiltered,
 * as freshness is about the data, not the selection. A failure reads as no
 * answer, never an error.
 */
function useFreshnessRow({ connection, query }: { connection: string; query: string }, wanted: boolean): SummaryRow | undefined {
    const key = `${connection}|${query}`;
    const known = answers.get(key);
    const run = wanted && !answers.has(key);
    const { data, error } = useSemanticModelQuery({ connection, query: run ? query : "" });

    const fresh = useMemo(() => {
        if (!run) return undefined;
        if (data?.status === "success") return toSummaryRow(data.table) ?? null;
        if (data?.status === "error" || error) return null;
        return undefined;
    }, [data, error, run]);

    useEffect(() => {
        if (fresh !== undefined) answers.set(key, fresh);
    }, [fresh, key]);

    if (!wanted) return undefined;
    return (known ?? fresh) ?? undefined;
}

function readDate(row: SummaryRow | undefined, column: string): string | undefined {
    const value = row?.[column];
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const QUERIES = {
    auditLog: auditLogFreshness(),
    m365Activity: m365ActivityFreshness(),
    productFeedback: productFeedbackFreshness(),
    agentRegistry: registryFreshness(),
    consumption: consumptionFreshness(),
    agentEvaluation: evaluatorFreshness(),
};

/**
 * The last date each of `sources` has data for, read once a session and only
 * from models this install has connected and sources that have data. Sources
 * still loading, failed or blank are simply missing.
 */
export function useSourceFreshness(sources: readonly FreshnessSource[]): FreshnessDates {
    const { semanticModels, modules } = runtimeConfig();
    const availability = useSourceAvailability();
    const wants = (source: FreshnessSource) => sources.includes(source);
    const consumption =
        modules?.consumption !== false &&
        isConnectionConfigured(semanticModels, consumptionConnection) &&
        (wants("cowork") || wants("copilotStudio") || wants("azure"));

    const auditLog = useFreshnessRow(QUERIES.auditLog, wants("auditLog"));
    const m365Activity = useFreshnessRow(
        QUERIES.m365Activity,
        wants("m365Activity") && modules?.m365Activity !== false && !isAbsent(availability, "m365Activity"),
    );
    const productFeedback = useFreshnessRow(
        QUERIES.productFeedback,
        wants("productFeedback") && modules?.productFeedback !== false && !isAbsent(availability, "productFeedback"),
    );
    const agentRegistry = useFreshnessRow(
        QUERIES.agentRegistry,
        wants("agentRegistry") && modules?.agent365 !== false && !isAbsent(availability, "agentRegistry"),
    );
    const credits = useFreshnessRow(QUERIES.consumption, consumption);
    const agentEvaluation = useFreshnessRow(
        QUERIES.agentEvaluation,
        wants("agentEvaluation") && modules?.agentEvaluator !== false && isConnectionConfigured(semanticModels, evaluatorConnection),
    );

    return useMemo(
        () => ({
            auditLog: readDate(auditLog, "[Last Date]"),
            m365Activity: readDate(m365Activity, "[Last Date]"),
            productFeedback: readDate(productFeedback, "[Last Date]"),
            agentRegistry: readDate(agentRegistry, "[Last Date]"),
            cowork: readDate(credits, "[Cowork Last Date]"),
            copilotStudio: readDate(credits, "[Studio Last Date]"),
            azure: readDate(credits, "[Azure Last Date]"),
            agentEvaluation: readDate(agentEvaluation, "[Last Date]"),
        }),
        [auditLog, m365Activity, productFeedback, agentRegistry, credits, agentEvaluation],
    );
}
