//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { withOrgAttribute } from "@/lib/org-attribute";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { m365ByOrg, m365CopilotIndex, m365CopilotSummary } from "@/queries/work-patterns";
import { CONCEALED_FIX } from "./copy";

const SUMMARY = m365CopilotSummary();
const INDEX = m365CopilotIndex();

const TITLE = "Copilot in the flow of work";
const DESCRIPTION = "How far Copilot reaches into the Microsoft 365 workforce, and how a Copilot user's week differs.";

function orgColumns(orgLabel: string, table: DataTable | undefined): GridColumnDef[] {
    return [
        { id: "Organization", header: orgLabel, minWidth: 200 },
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
    const columns = useMemo(() => orgColumns(org.label, byOrgTable), [org.label, byOrgTable]);

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

            <div
                className="h-[340px]"
                style={indexTable?.rows.length ? { height: rowChartHeight(indexTable.rows.length, { perRow: 44, chrome: 116 }) } : undefined}
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

            <div className="flex h-[560px] flex-col">
                {byOrgResult.data?.status === "error" ? (
                    <QueryError className="h-full" message={byOrgResult.data.error.message} onRetry={byOrgResult.refetch} />
                ) : byOrgResult.isLoading || !byOrgTable ? (
                    <QueryLoading className="h-full" />
                ) : byOrgTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title={`No ${org.plural} to compare`}
                        description={`Nobody active on Microsoft 365 in this selection has a ${org.noun} in the org data.`}
                    />
                ) : (
                    <DataGrid
                        columns={columns}
                        data={byOrgTable}
                        defaultSort={[{ columnId: "People Active", direction: "desc" }]}
                        theme={theme}
                        header={{
                            title: `Copilot reach by ${org.noun}`,
                            subtitle: `${formatKpi(byOrgTable.rows.length, "whole")} ${org.plural}, with their Microsoft 365 week per person`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
