//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, type ReactNode } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@/components/vega-visual";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { NoteCard, type Note } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { columnFormat, columnHeat, columnValues, heatRenderer } from "@/lib/heat";
import { withIndefiniteArticle, withOrgAttribute, type OrgAttribute } from "@/lib/org-attribute";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { m365ByOrg, m365CopilotIndex, m365CopilotSummary, SMALL_GROUP_MIN_PEOPLE } from "@/queries/work-patterns";
import { CONCEALED_FIX } from "./copy";

const SUMMARY = m365CopilotSummary();
const INDEX = m365CopilotIndex();

const TITLE = "Copilot in the flow of work";
const DESCRIPTION = "How far Copilot reaches into the Microsoft 365 workforce, and how a Copilot user's week differs.";

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function notes(org: OrgAttribute): Note[] {
    return [
        {
            term: "Copilot users",
            text: "Anyone with Copilot Chat or agent activity in the audit log during the selection. Everyone else active on Microsoft 365 is the comparison group.",
        },
        {
            term: "Licensed",
            text: "People marked as holding a Copilot license in the license list.",
        },
        {
            term: "The comparison",
            text: "Sets the two groups' weeks side by side. It shows the gap, not that Copilot caused it: people who take up Copilot early may already work differently.",
        },
        {
            term: "Small groups",
            text: `${capitalise(org.plural)} with fewer than ${SMALL_GROUP_MIN_PEOPLE} active people share one row, so no row describes a handful of people who could be picked out.`,
        },
    ];
}

/** How many organizations a pooled by-org row holds; 0 on an ordinary row. */
function pooledGroups(row: Record<string, unknown>): number {
    const pooled = row["Pooled Groups"];
    return typeof pooled === "number" && pooled > 0 ? pooled : 0;
}

function orgColumns(org: OrgAttribute, table: DataTable | undefined): GridColumnDef[] {
    return [
        {
            id: "Organization",
            header: org.label,
            minWidth: 200,
            cellRenderer: (value, row): ReactNode => {
                const pooled = pooledGroups(row);
                if (pooled === 0) return value;
                return (
                    <span className="text-muted-foreground">
                        {formatKpi(pooled, "whole")} smaller {pooled === 1 ? org.noun : org.plural}
                    </span>
                );
            },
        },
        { id: "Pooled Groups", header: "Groups pooled", hidden: true },
        { id: "People Active", header: "Active on Microsoft 365", numericStyling: true },
        { id: "Copilot Users", header: "Using Copilot", numericStyling: true },
        {
            id: "Copilot Reach",
            header: "Copilot reach",
            numericStyling: true,
            cellRenderer: heatRenderer({
                domain: columnHeat(table, "Copilot Reach"),
                format: columnFormat(table, "Copilot Reach"),
            }),
        },
        { id: "Active Days Per Week", header: "Active days per week", numericStyling: true },
        { id: "Meetings Per Week", header: "Meetings per week", numericStyling: true },
        { id: "Emails Sent Per Week", header: "Emails sent per week", numericStyling: true },
    ];
}

interface M365CopilotStageProps {
    /** The usage reports hide user names, so nobody can be matched to their Copilot use. */
    concealed: boolean;
}

/**
 * Microsoft 365 activity set against Copilot use. Anyone with Copilot Chat
 * or agent activity in the selection counts as a Copilot user; everyone else
 * active on Microsoft 365 is the comparison group.
 */
export function M365CopilotStage({ concealed }: M365CopilotStageProps) {
    if (concealed) {
        return (
            <Section id={stageAnchor("m365-copilot")} title={TITLE} description={DESCRIPTION}>
                <QueryEmpty
                    title="Can't match Microsoft 365 activity to Copilot use"
                    description={`The usage reports hide user names, so nobody here can be matched to their Copilot use. ${CONCEALED_FIX}`}
                />
            </Section>
        );
    }
    return <CopilotComparison />;
}

function CopilotComparison() {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const summary = useFilteredQuery(SUMMARY);
    const indexResult = useFilteredQuery(INDEX);
    const byOrg = useMemo(() => withOrgAttribute(m365ByOrg(), org), [org]);
    const byOrgResult = useFilteredQuery({ connection: byOrg.connection, query: byOrg.query });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );
    const indexTable = useMemo(
        () => (indexResult.data?.status === "success" ? toDataTable(indexResult.data.table, INDEX.columnMetadata) : undefined),
        [indexResult.data],
    );
    const byOrgTable = useMemo(
        () =>
            byOrgResult.data?.status === "success" ? toDataTable(byOrgResult.data.table, byOrg.columnMetadata) : undefined,
        [byOrgResult.data, byOrg.columnMetadata],
    );
    const columns = useMemo(() => orgColumns(org, byOrgTable), [org, byOrgTable]);
    const pooledCounts = useMemo(
        () => columnValues(byOrgTable, "Pooled Groups").map((value) => (typeof value === "number" && value > 0 ? value : 0)),
        [byOrgTable],
    );
    const groupCount = pooledCounts.reduce((sum, pooled) => sum + Math.max(1, pooled), 0);
    const hasPool = pooledCounts.some((pooled) => pooled > 0);

    const m365People = readNumber(summaryRow, "[M365 People]");
    const licensed = readNumber(summaryRow, "[Licensed People]");

    return (
        <Section id={stageAnchor("m365-copilot")} title={TITLE} description={DESCRIPTION}>
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-3">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !m365People ? (
                <QueryEmpty
                    title="Nobody active on Microsoft 365"
                    description="No one in the current selection has Microsoft 365 activity to compare with Copilot use."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-3">
                    <KpiCard
                        label="Copilot reach"
                        value={readNumber(summaryRow, "[Copilot Reach]")}
                        format="percent"
                        emphasis
                        detail={`${formatKpi(readNumber(summaryRow, "[Copilot People]") ?? 0, "whole")} of ${formatKpi(
                            m365People,
                            "whole",
                        )} people active on Microsoft 365 also used Copilot or an agent`}
                    />
                    <KpiCard
                        label="Not using Copilot yet"
                        value={readNumber(summaryRow, "[Not Using]")}
                        detail="worked on Microsoft 365 in this selection without touching Copilot Chat or an agent"
                    />
                    <KpiCard
                        label="Licensed, not using"
                        value={readNumber(summaryRow, "[Licensed Not Using]")}
                        detail={
                            licensed ? (
                                <KpiStat
                                    label={`Of ${formatKpi(licensed, "whole")} licensed people at work`}
                                    value={readNumber(summaryRow, "[Licensed Idle Share]")}
                                    format="percent"
                                />
                            ) : (
                                "No licensed people were active on Microsoft 365 in this selection"
                            )
                        }
                    />
                </div>
            )}

            <div className="grid gap-400 2xl:grid-cols-3">
                <div
                    className="h-[340px] 2xl:col-span-2"
                    style={
                        indexTable?.rows.length
                            ? { height: rowChartHeight(indexTable.rows.length, { perRow: 44, chrome: 116 }) }
                            : undefined
                    }
                >
                    {indexResult.data?.status === "error" ? (
                        <QueryError className="h-full" message={indexResult.data.error.message} onRetry={indexResult.refetch} />
                    ) : indexResult.isLoading || !indexTable ? (
                        <QueryLoading className="h-full" />
                    ) : indexTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="Nothing to compare yet"
                            description="The comparison needs people who use Copilot and people who don't in the same selection."
                        />
                    ) : (
                        <VegaVisual
                            spec={INDEX.vegaLiteSpec}
                            data={indexTable}
                            theme={theme}
                            header={{
                                title: "A Copilot user's week, against everyone else's",
                                subtitle:
                                    "Per person, per week. Right of 1× means Copilot users do more of it. This compares the two groups; it doesn't show Copilot caused the gap.",
                            }}
                        />
                    )}
                </div>

                <div className="2xl:self-start">
                    <NoteCard title="How these figures are worked out" notes={notes(org)} />
                </div>
            </div>

            <div className="flex h-[560px] flex-col">
                {byOrgResult.data?.status === "error" ? (
                    <QueryError className="h-full" message={byOrgResult.data.error.message} onRetry={byOrgResult.refetch} />
                ) : byOrgResult.isLoading || !byOrgTable ? (
                    <QueryLoading className="h-full" />
                ) : byOrgTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title={`No ${org.plural} to compare`}
                        description={`Nobody active on Microsoft 365 in this selection has ${withIndefiniteArticle(org.noun)} in the org data.`}
                    />
                ) : (
                    <DataGrid
                        columns={columns}
                        data={byOrgTable}
                        defaultSort={[{ columnId: "People Active", direction: "desc" }]}
                        theme={theme}
                        header={{
                            title: `Copilot reach by ${org.noun}`,
                            subtitle: `${formatKpi(groupCount, "whole")} ${groupCount === 1 ? org.noun : org.plural}, with their Microsoft 365 week per person${
                                hasPool ? `. Those under ${SMALL_GROUP_MIN_PEOPLE} active people share one row.` : ""
                            }`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
