//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryLoading } from "@/components/query-states";
import { ChartPanel, KpiRowState, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery } from "@/hooks/use-table-query";
import { rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import type { FilterKey } from "@/lib/filters";
import type { SourceState } from "@/lib/optional-sources";
import { readNumber } from "@/lib/summary-row";
import { BODY } from "@/lib/type-scale";
import {
    describeProbeStatus,
    layerToolsSpec,
    layerUnavailable,
    PROBE_LABELS,
    probeStatuses,
    readShadowAiState,
    SHADOW_AI_LAYERS,
    SHADOW_AI_POSTURES,
    shadowAiStatus,
    shadowAiSummary,
    shadowAiTools,
    toolsForLayer,
    type ProbeStatus,
    type ShadowAiLayer,
    type ShadowAiProbe,
} from "@/queries/governance";

const SUMMARY = shadowAiSummary();
const TOOLS = shadowAiTools();
const STATUS = shadowAiStatus();

/** Defender has no agent type, so the page's one filter is left off these queries. */
const IGNORE: readonly FilterKey[] = ["agentTypes"];
const NONE: readonly string[] = [];

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-4";

const TITLE = "Shadow AI";
const DESCRIPTION = "AI tools people use that you haven't sanctioned, as Microsoft Defender sees them on your devices and network.";

const NOTES = [
    {
        term: "A floor, not a census",
        text: "Defender only sees devices onboarded to Defender for Endpoint, and only the tools on the watchlist. Personal devices, unmanaged browsers and tools not on the list are missed, so the real figure is higher.",
    },
    {
        term: "Ran, reached and installed",
        text: "Ran counts devices that started a tool's app or process. Reached counts devices that connected to its web domains. Installed counts devices with it installed, from Defender Vulnerability Management.",
    },
    {
        term: "Cloud Discovery",
        text: "Generative AI apps Defender for Cloud Apps saw in firewall and proxy logs. It counts people per app, so it isn't added to the device figures.",
    },
    {
        term: "Posture",
        text: "Each watched tool starts as Not reviewed. Mark it Sanctioned or Unsanctioned in the watchlist, defender/ai_watchlist.csv in the Lakehouse files or the landing container; sanctioned tools leave this page.",
    },
] as const;

/** What to tell an admin when a probe was refused. */
function failureHint(probe: ProbeStatus): string {
    const label = PROBE_LABELS[probe.probe as ShadowAiProbe] ?? probe.probe;
    const status = describeProbeStatus(probe.status);
    return probe.message ? `${label}: ${status} (${probe.message})` : `${label}: ${status}`;
}

interface ShadowAiStageProps {
    source: SourceState;
}

/**
 * The optional Defender source: AI tools people use that you haven't
 * sanctioned. It reads nothing from the Agent 365 registry, so it stands
 * apart from the stages above and shows whether or not the registry is
 * connected. When the module is off or has never loaded it says how to turn
 * it on instead of running empty queries.
 */
export function ShadowAiStage({ source }: ShadowAiStageProps) {
    if (source === "absent" || source === "notConfigured") return <ConnectDefender configured={source !== "notConfigured"} />;
    if (source === "checking") {
        return (
            <Section id={stageAnchor("shadow-ai")} title={TITLE} description={DESCRIPTION}>
                <QueryLoading />
            </Section>
        );
    }
    return <ShadowAiFindings />;
}

function ShadowAiFindings() {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();
    const palette = useMemo(() => outcomePalette(outcomeColors, theme), [outcomeColors, theme]);
    const summary = useSummaryQuery(SUMMARY, NONE, IGNORE);
    const tools = useTableQuery(TOOLS, NONE, IGNORE);
    const status = useTableQuery(STATUS, NONE, IGNORE);
    const [layer, setLayer] = useState<ShadowAiLayer>("Ran");

    const statuses = useMemo(() => probeStatuses(status.table), [status.table]);
    const state = useMemo(() => readShadowAiState(status.table), [status.table]);
    const shown = useMemo(() => toolsForLayer(tools.table, layer), [tools.table, layer]);
    const spec = useMemo(
        () => withColorScale(layerToolsSpec(TOOLS.vegaLiteSpec, layer), SHADOW_AI_POSTURES, [palette.negative, palette.caution]),
        [layer, palette],
    );
    const current = SHADOW_AI_LAYERS.find((entry) => entry.id === layer) ?? SHADOW_AI_LAYERS[0];
    const layerDown = layerUnavailable(statuses, layer);
    const row = summary.row;

    if (state?.kind === "notRun") {
        return (
            <Section id={stageAnchor("shadow-ai")} title={TITLE} description={DESCRIPTION}>
                <QueryEmpty
                    title="Defender hasn't run yet"
                    description="The Defender source is on, but its first load hasn't finished. Shadow AI fills in after the next load and model refresh."
                />
            </Section>
        );
    }
    if (state?.kind === "noAccess") {
        return (
            <Section id={stageAnchor("shadow-ai")} title={TITLE} description={DESCRIPTION}>
                <QueryEmpty
                    title="Defender refused every probe"
                    description={`Grant the app ThreatHunting.Read.All (and CloudApp-Discovery.Read.All for Cloud Discovery) with admin consent, check the tenant has Defender for Endpoint P2 or Defender for Cloud Apps, then let the next load run. ${state.failing.map(failureHint).join(". ")}.`}
                />
            </Section>
        );
    }

    return (
        <Section id={stageAnchor("shadow-ai")} title={TITLE} description={DESCRIPTION}>
            {state?.kind === "partial" && (
                <p role="status" className={`flex max-w-[80ch] items-start gap-200 ${BODY} text-muted-foreground`}>
                    <TriangleAlert className="icon-size-200 mt-[2px] shrink-0 text-caution" aria-hidden="true" />
                    {`Some of Defender didn't load, so these figures leave it out. ${state.failing.map(failureHint).join(". ")}.`}
                </p>
            )}

            <KpiRowState
                summary={summary}
                count={4}
                className={KPI_GRID}
                emptyTitle="No shadow AI figures"
                emptyDescription="The Defender tables are empty. Check the Defender source ran, then refresh the model."
            >
                <KpiCard
                    label="Shadow AI tools found"
                    value={readNumber(row, "[Tools Found]")}
                    emphasis
                    detail={<KpiStat label="Of tools watched" value={readNumber(row, "[Tools Watched]")} />}
                />
                <KpiCard
                    label="Found this week"
                    value={readNumber(row, "[Tools This Week]")}
                    detail={<KpiStat label="Marked unsanctioned" value={readNumber(row, "[Unsanctioned Tools]")} />}
                />
                <KpiCard label="Devices" value={readNumber(row, "[Devices]")} />
                <KpiCard
                    label="People"
                    value={readNumber(row, "[Users]")}
                    detail={<KpiStat label="In Cloud Discovery" value={readNumber(row, "[Cloud Users]")} />}
                />
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex flex-col gap-300">
                    <SegmentedControl
                        label="Seen by"
                        className="self-start"
                        options={SHADOW_AI_LAYERS.map((entry) => ({
                            id: entry.id,
                            label: entry.label,
                            hint: layerUnavailable(statuses, entry.id) ? "This part of Defender didn't load on the last run." : entry.subtitle,
                        }))}
                        value={layer}
                        onChange={setLayer}
                    />
                    <ChartPanel
                        result={tools}
                        table={shown}
                        spec={spec}
                        height={rowChartHeight(shown?.rows.length ?? 6)}
                        title="Shadow AI tools"
                        subtitle={current.subtitle}
                        emptyTitle={layerDown ? "This part of Defender didn't load" : "No shadow AI seen here"}
                        emptyDescription={
                            layerDown
                                ? "The probe behind this view was refused or failed on the last run. The note above says why."
                                : "Defender saw none of the watched tools this way in the last 30 days."
                        }
                    />
                </div>
                <div className="self-start">
                    <NoteCard title="How to read this" notes={NOTES} />
                </div>
            </div>
        </Section>
    );
}

function ConnectDefender({ configured }: { configured: boolean }) {
    return (
        <Section id={stageAnchor("shadow-ai")} title={TITLE} description={DESCRIPTION}>
            <QueryEmpty
                title={configured ? "Connect Microsoft Defender" : "Defender isn't turned on"}
                description={
                    configured
                        ? "Shadow AI reads Microsoft Defender advanced hunting, and the model has no Defender data yet. Run the Defender source (or the installer again with Defender ticked), let the next load finish, then reopen the app."
                        : "Optional. Run the installer again and tick Defender (shadow AI and agent risk). It needs Defender for Endpoint P2 or Defender for Cloud Apps and the ThreatHunting.Read.All permission; Shadow AI fills in after the next load and model refresh."
                }
            />
        </Section>
    );
}
