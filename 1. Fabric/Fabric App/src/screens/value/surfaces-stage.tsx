//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { toDataTable } from "@/lib/to-data-table";
import { surfaceUsage } from "@/queries/work";

const surface = surfaceUsage({ lens: "surface" });
const model = surfaceUsage({ lens: "model" });

const charts = [
    {
        id: "surface",
        spec: surface.vegaLiteSpec,
        title: "Tasks by app",
        subtitle: "Which surface the request came from",
    },
    {
        id: "model",
        spec: model.vegaLiteSpec,
        title: "Tasks by model",
        subtitle: "Which model answered the request",
    },
];

/**
 * The second half of the Value destination's task breakdown: where the work
 * happens and which model answers it.
 *
 * The report draws eight bar charts here — two lenses times four cohorts, each
 * on its own bookmark. Here the filter bar's License and Activity pick the
 * cohort, and one query carries both lenses.
 */
export function SurfacesStage() {
    const { theme } = useThemeContext();

    const result = useFilteredQuery({ connection: surface.connection, query: surface.query });

    const table = useMemo(
        () =>
            result.data?.status === "success"
                ? toDataTable(result.data.table, surface.columnMetadata)
                : undefined,
        [result.data],
    );

    return (
        <Section
            title="Surfaces & models"
            description="Where Copilot is being used from, and what is answering. Together these say whether adoption is concentrated in one app or spread across the suite."
        >
            <div className="grid gap-300 lg:grid-cols-2">
                {charts.map((chart) => (
                    <div key={chart.id} className="h-[360px]">
                        {result.data?.status === "error" ? (
                            <QueryError
                                className="h-full"
                                message={result.data.error.message}
                                onRetry={result.refetch}
                            />
                        ) : result.isLoading || !table ? (
                            <QueryLoading className="h-full" />
                        ) : table.rows.length === 0 ? (
                            <QueryEmpty
                                className="h-full"
                                title="No usage recorded"
                                description="No rows carry an app or model value in this selection."
                            />
                        ) : (
                            <VegaVisual
                                spec={chart.spec}
                                data={table}
                                theme={theme}
                                header={{ title: chart.title, subtitle: chart.subtitle }}
                            />
                        )}
                    </div>
                ))}
            </div>
        </Section>
    );
}
