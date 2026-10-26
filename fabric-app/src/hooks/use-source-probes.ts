//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import {
    mergedSourceProbe,
    OPTIONAL_SOURCES,
    readMergedSourceState,
    readSourceState,
    SOURCE_PROBES,
    type OptionalSource,
    type SourceAvailability,
    type SourceState,
} from "@/lib/optional-sources";
import { isConnectionDeclared } from "@/lib/connections";
import { isBusyMessage } from "@/lib/query-scheduler";
import { runtimeConfig, type RuntimeModules } from "@/lib/runtime-config";
import { toSummaryRow } from "@/lib/summary-row";
import { connection } from "@/queries/shared";
import { useSemanticModelQuery } from "./use-semantic-model-query";

/** The installer module behind each source. */
const MODULE: Readonly<Record<OptionalSource, keyof RuntimeModules>> = {
    m365Activity: "m365Activity",
    productFeedback: "productFeedback",
    agentRegistry: "agent365",
    defender: "defender",
    resourceGraph: "resourceGraph",
};

/** The installer says the admin left the source's module off. One that says nothing is probed. */
function leftOff(modules: RuntimeModules | undefined, source: OptionalSource): boolean {
    return modules?.[MODULE[source]] === false;
}

/** One source's own probe, asked only once the merged probe has failed. */
function useProbe(source: OptionalSource, ask: boolean): SourceState {
    const { data, error } = useSemanticModelQuery({ connection, query: ask ? SOURCE_PROBES[source] : "" });
    return useMemo(
        () =>
            readSourceState({
                row: data?.status === "success" ? toSummaryRow(data.table) : undefined,
                loaded: data?.status === "success",
                error: data?.status === "error" ? data.error.message : error?.message,
            }),
        [data, error],
    );
}

/**
 * Probes the optional sources once, without the filter bar, so a filter that
 * empties the selection never takes a page away. One query counts every source
 * the installer didn't leave off. A model missing any of their tables fails it,
 * so when it fails for any reason but Power BI being busy, each source is asked
 * on its own as before, and a missing table still reads as absent. Every
 * source lives in the ValueLens model, so an install without it has none.
 */
export function useSourceProbes(): SourceAvailability {
    const { modules, semanticModels } = runtimeConfig();
    const valueLens = isConnectionDeclared(semanticModels, connection);
    const merged = useSemanticModelQuery({
        connection,
        query: mergedSourceProbe(OPTIONAL_SOURCES.filter((source) => !leftOff(modules, source))),
    });
    const failure = merged.data?.status === "error" ? merged.data.error.message : merged.error?.message;
    const alone = failure !== undefined && !isBusyMessage(failure);
    const m365Activity = useProbe("m365Activity", alone && !leftOff(modules, "m365Activity"));
    const productFeedback = useProbe("productFeedback", alone && !leftOff(modules, "productFeedback"));
    const agentRegistry = useProbe("agentRegistry", alone && !leftOff(modules, "agentRegistry"));
    const defender = useProbe("defender", alone && !leftOff(modules, "defender"));
    const resourceGraph = useProbe("resourceGraph", alone && !leftOff(modules, "resourceGraph"));
    const answer = merged.data;
    return useMemo(() => {
        const own: SourceAvailability = { m365Activity, productFeedback, agentRegistry, defender, resourceGraph };
        const row = answer?.status === "success" ? toSummaryRow(answer.table) : undefined;
        const state = (source: OptionalSource): SourceState => {
            if (!valueLens || leftOff(modules, source)) return "notConfigured";
            if (alone) return own[source];
            if (failure !== undefined) return "unknown";
            if (answer?.status !== "success") return "checking";
            return readMergedSourceState(row, source);
        };
        return {
            m365Activity: state("m365Activity"),
            productFeedback: state("productFeedback"),
            agentRegistry: state("agentRegistry"),
            defender: state("defender"),
            resourceGraph: state("resourceGraph"),
        };
    }, [valueLens, modules, answer, failure, alone, m365Activity, productFeedback, agentRegistry, defender, resourceGraph]);
}
