//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, type ReactNode } from "react";
import { VegaVisual, type VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { NoteCard, type Note } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { toDataTable } from "@/lib/to-data-table";
import { m365Apps, m365Platforms, m365SuiteDepth } from "@/queries/work-patterns";

const APPS = m365Apps();
const DEPTH = m365SuiteDepth();
const PLATFORMS = m365Platforms();

const TITLE = "Apps and devices";
const DESCRIPTION = "How much of the Microsoft 365 suite each person uses, and where they work from.";

const ROW_CHART = { perRow: 40, chrome: 100 };

const NOTES: Note[] = [
    {
        term: "Apps",
        text: "Outlook, Teams, Word, Excel, PowerPoint and OneNote, opened at least once in the selection on any platform.",
    },
    {
        term: "Suite depth",
        text: "How many of those six apps each active person opened. Someone who opened Word once counts the same as a daily user.",
    },
    {
        term: "No app use reported",
        text: "The person was active on email, SharePoint, OneDrive or Viva Engage, but the apps report had nothing for them. It doesn't mean they did no work.",
    },
    {
        term: "Platforms",
        text: "Windows, Mac, web and mobile, from the same apps report. Someone on a laptop and a phone counts on both, so the bars add up to more than 100%.",
    },
];

function useTable(config: typeof APPS | typeof DEPTH | typeof PLATFORMS) {
    const result = useFilteredQuery(config);
    const table = useMemo(
        () => (result.data?.status === "success" ? toDataTable(result.data.table, config.columnMetadata) : undefined),
        [result.data, config.columnMetadata],
    );
    return { result, table };
}

interface BarChartProps {
    query: ReturnType<typeof useTable>;
    spec: VisualizationSpec;
    height: number | undefined;
    title: string;
    subtitle: string;
    empty: { title: string; description: string };
}

function BarChart({ query: { result, table }, spec, height, title, subtitle, empty }: BarChartProps): ReactNode {
    const { theme } = useThemeContext();
    return (
        <div className="h-[340px]" style={height ? { height } : undefined}>
            {result.data?.status === "error" ? (
                <QueryError className="h-full" message={result.data.error.message} onRetry={result.refetch} />
            ) : result.isLoading || !table ? (
                <QueryLoading className="h-full" />
            ) : table.rows.length === 0 ? (
                <QueryEmpty className="h-full" title={empty.title} description={empty.description} />
            ) : (
                <VegaVisual spec={spec} data={table} theme={theme} header={{ title, subtitle }} />
            )}
        </div>
    );
}

function rowsOf(table: DataTable | undefined): number {
    return table?.rows.length ?? 0;
}

/**
 * Which Microsoft 365 apps people open, how many of them each person uses,
 * and on which platforms. All three come from the usage reports' app detail,
 * so they don't depend on Copilot at all.
 */
export function M365SuiteStage() {
    const apps = useTable(APPS);
    const depth = useTable(DEPTH);
    const platforms = useTable(PLATFORMS);

    // The apps and depth charts sit side by side, so they share one height and their bars line up.
    const pairRows = Math.max(rowsOf(apps.table), rowsOf(depth.table));
    const pairHeight = pairRows > 0 ? rowChartHeight(pairRows, ROW_CHART) : undefined;
    const platformHeight = rowsOf(platforms.table) > 0 ? rowChartHeight(rowsOf(platforms.table), ROW_CHART) : undefined;

    return (
        <Section id={stageAnchor("m365-suite")} title={TITLE} description={DESCRIPTION}>
            <div className="grid gap-400 xl:grid-cols-2">
                <BarChart
                    query={apps}
                    spec={APPS.vegaLiteSpec}
                    height={pairHeight}
                    title="Which apps people open"
                    subtitle="Share of active people, on desktop, web or mobile."
                    empty={{ title: "No app activity", description: "Nobody in the current selection opened a Microsoft 365 app." }}
                />
                <BarChart
                    query={depth}
                    spec={DEPTH.vegaLiteSpec}
                    height={pairHeight}
                    title="How much of the suite each person uses"
                    subtitle="Share of active people by how many of the six apps they opened."
                    empty={{ title: "Nobody active", description: "No one in the current selection was active on Microsoft 365." }}
                />
                <BarChart
                    query={platforms}
                    spec={PLATFORMS.vegaLiteSpec}
                    height={platformHeight}
                    title="Where people work from"
                    subtitle="Share of active people on each platform, with days per week in the tooltip."
                    empty={{
                        title: "No platform reported",
                        description: "The apps report had no platform for anyone in the current selection.",
                    }}
                />
                <div className="xl:self-start">
                    <NoteCard title="How these figures are worked out" notes={NOTES} />
                </div>
            </div>
        </Section>
    );
}
