//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { ChartPanel, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { useTableQuery, type SummaryResult } from "@/hooks/use-table-query";
import { rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import { readNumber } from "@/lib/summary-row";
import { governanceOwners, OWNER_STATUSES } from "@/queries/governance";

const OWNERS = governanceOwners();

interface AccountabilityStageProps {
    summary: SummaryResult;
}

/**
 * Whether someone is still accountable for each agent built here. An agent
 * whose owner has left keeps running, keeps its sharing and keeps reading
 * what it was given, with nobody to answer for it.
 */
export function AccountabilityStage({ summary }: AccountabilityStageProps) {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();
    const palette = useMemo(() => outcomePalette(outcomeColors, theme), [outcomeColors, theme]);
    const owners = useTableQuery(OWNERS);

    // Disabled and missing owners share the negative tone: either way nobody answers for the agent.
    const spec = useMemo(
        () =>
            withColorScale(OWNERS.vegaLiteSpec, OWNER_STATUSES, [
                palette.positive,
                palette.negative,
                palette.negative,
                palette.caution,
                palette.neutral,
            ]),
        [palette],
    );

    const unchecked = summary.loaded && (readNumber(summary.row, "[Owners Checked]") ?? 0) === 0;

    return (
        <Section
            id={stageAnchor("accountability")}
            title="Accountability"
            description="Whether the person who built each agent is still here to answer for it."
        >
            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={owners}
                    spec={spec}
                    height={rowChartHeight(owners.table?.rows.length ?? OWNER_STATUSES.length)}
                    title="Owner status"
                    subtitle="Tenant-built agents, by whether their creator's account is still active"
                    emptyTitle="No tenant-built agents"
                    emptyDescription="The registry holds no agents built in this tenant for these filters."
                />
                <div className="self-start">
                    <NoteCard
                        title="How owners are checked"
                        notes={[
                            {
                                term: "Owner account",
                                text: "Each run, the registry ingester looks up every creator in Entra ID and records whether the account is active, disabled or gone. It needs the User.Read.All permission.",
                            },
                            {
                                term: "Not checked",
                                text: unchecked
                                    ? "No owner has been checked yet: the registry was loaded from an export, or the ingester ran with CHECK_OWNER_ACCOUNT = False. Rerun the registry ingester with it on to fill this in."
                                    : "Agents whose creator wasn't looked up, such as those added since the last ingester run.",
                            },
                        ]}
                    />
                </div>
            </div>
        </Section>
    );
}
