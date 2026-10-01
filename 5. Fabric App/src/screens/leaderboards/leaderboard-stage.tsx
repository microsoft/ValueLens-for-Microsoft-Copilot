//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import type { QueryTable } from "@microsoft/fabric-app-data";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { TreeFrame } from "@/components/tree-frame";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useRowToggles } from "@/hooks/use-row-toggles";
import { gridHeight } from "@/lib/chart-height";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";
import { heatDomain, heatRenderer } from "@/lib/heat";
import { isGroupRow, visibleRowCount, type RollupTree } from "@/lib/rollup-tree";
import { scrollToAnchor } from "@/lib/scroll-to-anchor";
import { readNumber, readText, toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import { formatCell, textCell, totalsRow, TREE_GRID, withExpansion } from "@/lib/tree-grid";
import {
    LEADERBOARD_LABEL_COLUMN,
    leaderboardCohorts,
    leaderboardPeople,
    leaderboardSummary,
    leaderboardSummaryColumns,
    leaderboardTasks,
    toLeaderboardPeopleTree,
    toLeaderboardTaskTree,
    type LeaderboardCohort,
} from "@/queries/work";

type Breakdown = "people" | "tasks";

const breakdowns: { id: Breakdown; label: string }[] = [
    { id: "people", label: "Users" },
    { id: "tasks", label: "Tasks" },
];

const PER_WEEK = "Sessions Per User Per Week";

const SMALL = "text-[length:var(--text-200)] leading-200";

interface CardExtra {
    label: string;
    column: string;
    format: KpiFormat;
}

/** The figures each of the report's bookmarks adds to the four every cohort shares, by the card they sit under. */
const CARD_EXTRAS: Record<LeaderboardCohort, { users?: CardExtra; sessions?: CardExtra; perUser?: CardExtra }> = {
    all: {},
    licensed: { users: { label: "License utilization", column: "[Licence Utilisation]", format: "percent" } },
    unlicensed: { sessions: { label: "AI tasks", column: "[Unlicensed Tasks]", format: "whole" } },
    agents: {
        sessions: { label: "AI tasks", column: "[Agent Tasks]", format: "whole" },
        perUser: { label: "Return rate (2+ sessions)", column: "[Agent Return Rate]", format: "percent" },
    },
    cowork: { sessions: { label: "AI tasks", column: "[Cowork Tasks]", format: "whole" } },
};

/** What a cohort's sessions are called when there are none. */
const SESSIONS_NOUN: Record<LeaderboardCohort, string> = {
    all: "sessions",
    licensed: "licensed sessions",
    unlicensed: "unlicensed sessions",
    agents: "agent sessions",
    cowork: "Cowork sessions",
};

function cohortLabel(cohort: LeaderboardCohort): string {
    return leaderboardCohorts.find((entry) => entry.id === cohort)?.label ?? cohort;
}

function extraStat(extra: CardExtra | undefined, row: SummaryRow | undefined): ReactNode {
    return extra ? <KpiStat label={extra.label} value={readNumber(row, extra.column)} format={extra.format} /> : undefined;
}

/** The named cards list every name on a tie, one per line. */
function names(row: SummaryRow | undefined, column: string): string[] {
    return (readText(row, column) ?? "")
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
}

/** The Agents bookmark's two named cards, shown only when the model can name someone. */
function AgentHighlights({ row }: { row: SummaryRow | undefined }) {
    const agents = names(row, "[Agent With Most Users]");
    const creators = names(row, "[Top Agent Builder Creator]");
    const highlights = [
        {
            label: agents.length > 1 ? "Agents with most users (tied)" : "Agent with most users",
            names: agents,
        },
        {
            label: creators.length > 1 ? "Top Agent Builder creators (by users, tied)" : "Top Agent Builder creator (by users)",
            names: creators,
        },
    ].filter((highlight) => highlight.names.length > 0);
    if (highlights.length === 0) return null;

    return (
        <dl className="grid gap-300 md:grid-cols-2">
            {highlights.map((highlight) => (
                <div key={highlight.label} className="flex flex-col gap-100 rounded-xl border border-border bg-card px-500 py-400">
                    <dt className={`${SMALL} text-muted-foreground`}>{highlight.label}</dt>
                    <dd className="text-[length:var(--text-400)] leading-400 font-semibold text-card-foreground">
                        {highlight.names.join(", ")}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/** The report's footnote, set beside the table: how the ranking counts, and what it leaves out. */
function RankingNotes({ cohort, unassigned }: { cohort: LeaderboardCohort; unassigned: string | undefined }) {
    const headingId = useId();
    const terms = [
        { term: "Session", definition: "One conversation, counted per user and per app." },
        { term: "Active user", definition: "Someone with at least one AI task in the period." },
        { term: "Sessions / user / week", definition: "Averaged over the weeks each person was active." },
        ...(cohort === "agents"
            ? [{ term: "Return rate (2+ sessions)", definition: "The share of agent users who came back for a second agent session." }]
            : []),
        ...(cohort === "cowork"
            ? [{ term: "Cowork", definition: "Sessions in the Cowork surface. Break down by Tasks to see what the work was." }]
            : []),
        ...(unassigned ? [{ term: unassigned, definition: "People who are not in the org data." }] : []),
    ];

    return (
        <article aria-labelledby={headingId} className="flex flex-col gap-400 rounded-xl border border-border bg-card p-500">
            <div className="flex flex-col gap-100">
                <h3 id={headingId} className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">
                    How the ranking works
                </h3>
                <p className={`${SMALL} text-muted-foreground`}>
                    Ranked by sessions, busiest first. Select a column heading to rank by it instead.
                </p>
            </div>
            <dl className="grid gap-x-600 gap-y-300 md:grid-cols-2 2xl:grid-cols-1">
                {terms.map(({ term, definition }) => (
                    <div key={term} className="flex flex-col gap-100">
                        <dt className={`${SMALL} font-semibold text-foreground`}>{term}</dt>
                        <dd className={`${SMALL} text-muted-foreground`}>{definition}</dd>
                    </div>
                ))}
            </dl>
            <div className="flex flex-col gap-200 border-t border-border pt-300">
                <p className={`${SMALL} text-muted-foreground`}>
                    Security Copilot is left out: its near-automated sessions would top every ranking.
                </p>
                {cohort === "agents" && (
                    <button
                        type="button"
                        onClick={() => scrollToAnchor(stageAnchor("agent-registry"))}
                        className={`inline-flex w-fit items-center gap-100 ${SMALL} font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                    >
                        Every agent, ranked by its users
                        <ArrowDown className="icon-size-100" aria-hidden="true" />
                    </button>
                )}
            </div>
        </article>
    );
}

interface BreakdownSource {
    connection: string;
    query: string;
    columnMetadata: ColumnMetadataMap;
    toTree: (table: DataTable) => RollupTree;
    heading: string;
    title: string;
    subtitle: (groups: number) => string;
    /** A person row would only ever count one active user. */
    peopleLeaves: boolean;
    /** Stands in for a blank org value, which the notes explain. */
    blankLabel?: string;
    emptyTitle: string;
    emptyDescription: string;
}

/**
 * The query hook holds on to the last result until the next one lands, so a
 * result is only read once its columns are the ones this query returns.
 */
function isShapedFor(table: QueryTable, metadata: ColumnMetadataMap): boolean {
    return table.columns.every((column) => column.name in metadata);
}

/**
 * One cohort's sessions as a tree: by org group then person, or by where the
 * sessions happened then what was done there — for Cowork, by task group
 * then category — with the report's footnote beside it.
 */
function LeaderboardBreakdown({ cohort, view }: { cohort: LeaderboardCohort; view: Breakdown }) {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const label = cohortLabel(cohort);

    const source: BreakdownSource = useMemo(() => {
        if (view === "people") {
            const blankLabel = `Unassigned ${org.noun}`;
            return {
                ...leaderboardPeople(cohort, org),
                toTree: (table) => toLeaderboardPeopleTree(table, blankLabel),
                heading: `${org.label} / user`,
                title: `${label} · ${org.label} → user`,
                subtitle: (groups) =>
                    `${formatKpi(groups, "whole")} ${groups === 1 ? org.noun : org.plural}, busiest first. Open one to rank its people.`,
                peopleLeaves: true,
                blankLabel,
                emptyTitle: "Nobody to rank",
                emptyDescription: `No one had ${SESSIONS_NOUN[cohort]} in this selection.`,
            };
        }
        const { levels, ...tasks } = leaderboardTasks(cohort);
        return {
            ...tasks,
            toTree: (table) => toLeaderboardTaskTree(table, levels),
            heading: levels.heading,
            title: `${label} · ${levels.path}`,
            subtitle: (groups) =>
                `${formatKpi(groups, "whole")} ${groups === 1 ? levels.groupNoun : levels.groupPlural}, busiest first. Open one to see its ${levels.leafPlural}.`,
            peopleLeaves: false,
            emptyTitle: "No sessions to break down",
            emptyDescription: `No ${SESSIONS_NOUN[cohort]} in this selection record a ${levels.groupNoun}.`,
        };
    }, [cohort, view, org, label]);

    const result = useFilteredQuery({ connection: source.connection, query: source.query });
    const tree = useMemo(() => {
        if (result.data?.status !== "success" || !isShapedFor(result.data.table, source.columnMetadata)) return undefined;
        return source.toTree(toDataTable(result.data.table, source.columnMetadata));
    }, [result.data, source]);

    const gridKey = `${cohort}|${view}|${org.column}|${tree?.rows.map((row) => row._id).join("|") ?? ""}`;
    const rows = useMemo(() => withExpansion(tree, false), [tree]);
    const { ids, onRowToggle } = useRowToggles(gridKey);

    const heat = useMemo(() => {
        const groups = tree?.rows ?? [];
        const leaves = groups.flatMap((row) => (row._children as Row[] | undefined) ?? []);
        return {
            group: heatDomain(groups.map((row) => row[PER_WEEK])),
            leaf: heatDomain(leaves.map((row) => row[PER_WEEK])),
        };
    }, [tree]);

    const columns: GridColumnDef[] = useMemo(
        () => [
            {
                id: LEADERBOARD_LABEL_COLUMN,
                header: source.heading,
                width: 320,
                cellRenderer: (value, row): ReactNode =>
                    isGroupRow(row) ? <span className="font-semibold">{textCell(value)}</span> : textCell(value),
            },
            {
                id: "Active Users",
                header: "Active users",
                width: 124,
                numericStyling: true,
                cellRenderer: source.peopleLeaves
                    ? (value, row) => (isGroupRow(row) ? formatCell("whole")(value) : null)
                    : formatCell("whole"),
            },
            { id: "Sessions", header: "Sessions", width: 112, numericStyling: true, cellRenderer: formatCell("whole") },
            {
                id: PER_WEEK,
                header: "Sessions / user / week",
                width: 184,
                numericStyling: true,
                cellRenderer: heatRenderer({
                    // Groups and the rows inside them sit on different scales, so each level heats against its peers.
                    domain: (row) => (isGroupRow(row) ? heat.group : heat.leaf),
                    format: formatCell("decimal"),
                }),
            },
        ],
        [source, heat],
    );

    const total = useMemo(
        () =>
            totalsRow(tree?.total, [
                { id: LEADERBOARD_LABEL_COLUMN },
                { id: "Active Users", format: formatCell("whole") },
                { id: "Sessions", format: formatCell("whole") },
                { id: PER_WEEK, format: formatCell("decimal") },
            ]),
        [tree],
    );
    const visible = visibleRowCount(rows ?? [], (row) => ids.has(row._id as string));
    const unassigned =
        source.blankLabel && tree?.rows.some((row) => row[LEADERBOARD_LABEL_COLUMN] === source.blankLabel)
            ? source.blankLabel
            : undefined;

    return (
        <div className="grid grid-cols-1 items-start gap-500 2xl:grid-cols-[minmax(0,1fr)_300px]">
            <TreeFrame
                tree={tree}
                error={result.data?.status === "error" ? result.data.error.message : undefined}
                onRetry={result.refetch}
                isLoading={result.isLoading}
                height={tree ? gridHeight(visible + (total ? 1 : 0), TREE_GRID) : undefined}
                emptyTitle={source.emptyTitle}
                emptyDescription={source.emptyDescription}
            >
                <DataGrid
                    key={gridKey}
                    columns={columns}
                    data={rows}
                    defaultSort={[{ columnId: "Sessions", direction: "desc" }]}
                    grandTotals={total ? { position: "bottom", data: total } : undefined}
                    onRowToggle={onRowToggle}
                    theme={theme}
                    header={{ title: source.title, subtitle: source.subtitle(tree?.rows.length ?? 0) }}
                />
            </TreeFrame>
            <RankingNotes cohort={cohort} unassigned={unassigned} />
        </div>
    );
}

/**
 * The people half of the Leaderboards destination, as the report's
 * Leaderboard page: who uses Copilot most and for what, ranked by sessions.
 *
 * The report shows each cohort on its own bookmark, with the people table
 * and the app-and-activity table side by side. Here the cohort toggle swaps
 * the cards and the table together, and one table flips between the two
 * breakdowns so each gets the full width.
 */
export function LeaderboardStage() {
    const [cohort, setCohort] = useState<LeaderboardCohort>("all");
    const [view, setView] = useState<Breakdown>("people");

    const summary = useFilteredQuery(leaderboardSummary());
    const row = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const columns = leaderboardSummaryColumns(cohort);
    const users = readNumber(row, columns.users);
    const sessions = readNumber(row, columns.sessions);
    const extras = CARD_EXTRAS[cohort];
    const isEmpty =
        summary.data?.status === "success" && !summary.isLoading && users === undefined && sessions === undefined;

    return (
        <Section
            id={stageAnchor("leaderboard")}
            title="Leaderboard"
            description="Who uses Copilot most, and for what, ranked by sessions. Pick a cohort, then break its sessions down by user or by task."
            actions={<SegmentedControl label="Cohort" options={leaderboardCohorts} value={cohort} onChange={setCohort} />}
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: 4 }, (_, i) => (
                        <QueryLoading key={i} />
                    ))}
                </div>
            ) : isEmpty ? (
                <QueryEmpty
                    title={`No ${SESSIONS_NOUN[cohort]} in this selection`}
                    description={
                        cohort === "cowork"
                            ? "Cowork sessions are ranked here as soon as the audit log records them. If you expected some, widen the dates or clear a filter."
                            : "Nobody in this cohort used Copilot in the selected period. Widen the dates or clear a filter."
                    }
                />
            ) : (
                <>
                    <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                        <KpiCard label="Active users" value={users} emphasis detail={extraStat(extras.users, row)} />
                        <KpiCard label="Sessions" value={sessions} detail={extraStat(extras.sessions, row)} />
                        <KpiCard
                            label="Sessions / user"
                            value={readNumber(row, columns.perUser)}
                            format="rate"
                            detail={extraStat(extras.perUser, row)}
                        />
                        <KpiCard label="Sessions / user / week" value={readNumber(row, columns.perWeek)} format="rate" />
                    </div>
                    {cohort === "agents" && <AgentHighlights row={row} />}
                </>
            )}

            {!isEmpty && (
                <div className="flex flex-col gap-300">
                    <div className="flex flex-wrap items-center gap-300">
                        <span aria-hidden="true" className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">
                            Break down by
                        </span>
                        <SegmentedControl label="Break down by" options={breakdowns} value={view} onChange={setView} />
                    </div>
                    <LeaderboardBreakdown cohort={cohort} view={view} />
                </div>
            )}
        </Section>
    );
}
