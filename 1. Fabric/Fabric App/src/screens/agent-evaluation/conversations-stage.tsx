//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { ChartPanel, KpiRowState, NoteCard, Panel, RollupGrid, type TreeColumn } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { useSummaryQuery, useTableQuery } from "@/hooks/use-table-query";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import { columnValues } from "@/lib/heat";
import { parseVerdict, plainText } from "@/lib/model-text";
import { readNumber, readText } from "@/lib/summary-row";
import { formatCell, textCell } from "@/lib/tree-grid";
import {
    answerArchetypes,
    conversationsSummary,
    feedbackComments,
    knowledgeSources,
    OUTCOMES,
    readableArchetypes,
    themeOutcomes,
    toTopicTree,
    topicHealth,
    TOPIC_LABEL_COLUMN,
} from "@/queries/agent-evaluation";
import { ARCHETYPE_HEADLINE, SOURCE_HEADLINE, THEME_HEADLINE } from "./headlines";

const SUMMARY = conversationsSummary();
const THEMES = themeOutcomes();
const TOPICS = topicHealth();
const SOURCES = knowledgeSources();
const ARCHETYPES = answerArchetypes();
const COMMENTS = feedbackComments();

const KPI_GRID = "grid gap-300 md:grid-cols-2 xl:grid-cols-4";
const NO_STACK_LABELS = { disableStackedDataLabels: true };
const RANKED_BARS = { perRow: 36, chrome: 148 };

function topicColumns(badColor: string): TreeColumn[] {
    return [
        { id: "Conversations", header: "Conversations", width: 132, format: formatCell("whole"), heat: true },
        { id: "Resolved", header: "Resolved", width: 104, format: formatCell("percent") },
        { id: "Failing", header: "Failing", width: 96, format: formatCell("whole"), heat: true, heatColor: badColor },
        { id: "Friction", header: "Friction", width: 96, format: formatCell("whole") },
        { id: "Knowledge Gaps", header: "Knowledge gaps", width: 144, format: formatCell("whole") },
        { id: "Turns To Resolve", header: "Turns to resolve", width: 140, format: formatCell("decimal") },
        { id: "CSAT", header: "Satisfaction", width: 116, format: formatCell("percent") },
    ];
}

function commentColumns(positive: string, negative: string): GridColumnDef[] {
    return [
        {
            id: "Verdict",
            header: "Feedback",
            width: 132,
            cellRenderer: (value) => {
                const label = textCell(value);
                return (
                    <span className="inline-flex items-center gap-200">
                        <span
                            aria-hidden="true"
                            className="size-200 shrink-0 rounded-full"
                            style={{ backgroundColor: label === "Negative" ? negative : positive }}
                        />
                        <span>{label}</span>
                    </span>
                );
            },
        },
        { id: "Comment", header: "Comment", minWidth: 320 },
        { id: "Times", header: "Times", width: 96, numericStyling: true, cellRenderer: formatCell("whole") },
    ];
}

/**
 * The report's topic, knowledge and feedback pages: what people asked about,
 * how each theme ended, where agents found their answers and what people
 * wrote back. Never the conversations themselves.
 */
export function ConversationsStage({ extra }: { extra: readonly string[] }) {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();
    const palette = useMemo(() => outcomePalette(outcomeColors, theme), [outcomeColors, theme]);

    const summary = useSummaryQuery(SUMMARY, extra);
    const themes = useTableQuery(THEMES, extra);
    const topics = useTableQuery(TOPICS, extra);
    const sources = useTableQuery(SOURCES, extra);
    const archetypes = useTableQuery(ARCHETYPES, extra);
    const comments = useTableQuery(COMMENTS, extra);
    const row = summary.row;

    const archetypeTable = useMemo(
        () => (archetypes.table ? readableArchetypes(archetypes.table) : undefined),
        [archetypes.table],
    );
    const themeSpec = useMemo(
        () => withColorScale(THEMES.vegaLiteSpec, OUTCOMES, [palette.positive, palette.neutral, palette.caution, palette.negative]),
        [palette],
    );
    const topicGridColumns = useMemo(() => topicColumns(palette.negative), [palette.negative]);
    const commentGridColumns = useMemo(
        () => commentColumns(palette.positive, palette.negative),
        [palette.positive, palette.negative],
    );

    const themeCount = useMemo(() => new Set(columnValues(themes.table, "Theme")).size, [themes.table]);
    const friction = parseVerdict(readText(row, "[Friction Read]"));

    return (
        <Section
            id={stageAnchor("agent-conversations")}
            title="Conversations & topics"
            description="What people asked about, where agents found answers, and what people wrote back. Never the conversations themselves."
        >
            <KpiRowState
                summary={summary}
                count={4}
                className={KPI_GRID}
                emptyTitle="No agent conversations"
                emptyDescription="Agent Evaluator has no conversations for these slicers. Widen the dates, or check that the transcripts have loaded."
            >
                <KpiCard
                    label="Grounded in knowledge"
                    value={readNumber(row, "[Grounded Rate]")}
                    format="percent"
                    emphasis
                    detail={<KpiStat label="Citations" value={readNumber(row, "[Citations]")} />}
                />
                <KpiCard
                    label="Searches with no answer"
                    value={readNumber(row, "[Knowledge Gap Rate]")}
                    format="percent"
                    detail={<KpiStat label="Conversations with a gap" value={readNumber(row, "[Knowledge Gap Conversations]")} />}
                />
                <KpiCard
                    label="Turns per conversation"
                    value={readNumber(row, "[Turns Per Conversation]")}
                    format="rate"
                    detail={
                        <div className="flex flex-col gap-100">
                            <KpiStat label="Answered in one turn" value={readNumber(row, "[Single Turn Rate]")} format="percent" />
                            <KpiStat label="Turns to resolve" value={readNumber(row, "[Turns To Resolve]")} format="rate" />
                        </div>
                    }
                />
                <KpiCard
                    label="Friction, out of 100"
                    value={readNumber(row, "[Friction]")}
                    detail={friction?.label}
                />
            </KpiRowState>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={themes}
                    spec={themeSpec}
                    capabilities={NO_STACK_LABELS}
                    height={rowChartHeight(themeCount || 6, RANKED_BARS)}
                    headline={THEME_HEADLINE}
                    title="How each theme ended"
                    subtitle="Conversations in each topic theme, the busiest first"
                    emptyTitle="No topic themes"
                    emptyDescription="No conversations in these slicers were matched to a topic."
                />
                <div className="self-start">
                    <NoteCard
                        title="What to fix first"
                        notes={[
                            { term: "Top fix", text: plainText(readText(row, "[Top Fix]")) },
                            { term: "Backlog", text: plainText(readText(row, "[Backlog Summary]")) },
                            { term: "Themes", text: plainText(readText(row, "[Theme Verdict]")) },
                            { term: "Topics", text: plainText(readText(row, "[Topic Insight]")) },
                        ]}
                    />
                </div>
            </div>

            <RollupGrid
                result={topics}
                toTree={toTopicTree}
                labelColumn={TOPIC_LABEL_COLUMN}
                labelHeader="Theme / topic"
                labelWidth={248}
                columns={topicGridColumns}
                variant="topics"
                title="Topic health"
                subtitle="Each theme, then its topics, the most failing first"
                emptyTitle="No topics"
                emptyDescription="No conversations in these slicers were matched to a topic."
            />

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-2">
                <ChartPanel
                    result={sources}
                    spec={SOURCES.vegaLiteSpec}
                    height={rowChartHeight(sources.table?.rows.length ?? 6, RANKED_BARS)}
                    headline={SOURCE_HEADLINE}
                    title="Where answers came from"
                    subtitle="The ten knowledge sources agents cited most"
                    emptyTitle="No citations"
                    emptyDescription="No answer in these slicers cited a knowledge source."
                />
                <div className="flex flex-col gap-500">
                    <ChartPanel
                        result={archetypes}
                        table={archetypeTable}
                        spec={ARCHETYPES.vegaLiteSpec}
                        height={rowChartHeight(archetypeTable?.rows.length ?? 4, RANKED_BARS)}
                        headline={ARCHETYPE_HEADLINE}
                        title="How each conversation was answered"
                        subtitle="From your content, from the model alone, by a person, or not at all"
                        emptyTitle="No answers"
                        emptyDescription="No conversations fall in these slicers."
                    />
                    <NoteCard
                        title="Knowledge"
                        notes={[
                            { term: "Sources", text: plainText(readText(row, "[Knowledge Story]")) },
                            { term: "Gaps", text: plainText(readText(row, "[Knowledge Gap Read]")) },
                            { term: "Conversation depth", text: plainText(readText(row, "[Depth Read]")) },
                        ]}
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <Panel
                    result={comments}
                    height={gridHeight(comments.table?.rows.length ?? 8)}
                    emptyTitle="No written feedback"
                    emptyDescription="People left thumbs up or down in these slicers, but no comments."
                >
                    {(table) => (
                        <DataGrid
                            columns={commentGridColumns}
                            data={table}
                            theme={theme}
                            header={{ title: "What people wrote", subtitle: "Comments left with a thumbs up or down, the most repeated first" }}
                        />
                    )}
                </Panel>
                <div className="self-start">
                    <NoteCard
                        title="What people said"
                        notes={[
                            { term: "Feedback", text: plainText(readText(row, "[Feedback Insight]")) },
                            { term: "Satisfaction", text: plainText(readText(row, "[CSAT Story]")) },
                        ]}
                    />
                </div>
            </div>
        </Section>
    );
}
