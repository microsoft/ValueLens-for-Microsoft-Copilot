//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useTaskTimes } from "@/hooks/task-times.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { INPUT, PRIMARY, SECONDARY } from "@/lib/form-controls";
import { formatKpi } from "@/lib/format-kpi";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import {
    modelTaskTimes,
    readHoursPerMinute,
    readModelTaskTimes,
    taskHoursPerMinute,
    type ScenarioBand,
} from "@/queries/assumptions";
import {
    buildRows,
    filterRows,
    formatMinutes,
    grainLabel,
    lastChange,
    pendingChanges,
    sortRows,
    toDraft,
    typicalHours,
    type Drafts,
    type TaskTimeRow,
} from "./task-time-rows";

/** The model's Low, Typical and High minutes, named as the Value page's effort scenarios. */
const BANDS: readonly { band: ScenarioBand; label: string }[] = [
    { band: "low", label: "Conservative" },
    { band: "typical", label: "Typical" },
    { band: "high", label: "Optimistic" },
];

type View = "all" | "custom";

const HEAD = "py-200 font-semibold shadow-[inset_0_-1px_0_var(--color-border)]";
const CELL = "border-b border-border py-300";
const LINK =
    "inline-flex items-baseline gap-100 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const GHOST =
    "rounded-md px-200 py-100 font-semibold whitespace-nowrap text-primary transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

const hoursPerMinuteSource = taskHoursPerMinute();

function safeUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function sameMinutes(a: number, b: number): boolean {
    return Math.round(a * 10) === Math.round(b * 10);
}

function hours(value: number | undefined): string {
    return value === undefined ? "—" : `${formatKpi(value, "whole")} h`;
}

function tasks(count: number): string {
    return `${formatKpi(count, "whole")} ${count === 1 ? "task" : "tasks"}`;
}

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function changedLine(saved: ReturnType<typeof lastChange>): string | undefined {
    if (!saved?.updatedAt) return undefined;
    const when = saved.updatedAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return saved.updatedBy ? `Last changed by ${saved.updatedBy} on ${when}.` : `Last changed on ${when}.`;
}

interface TaskRowProps {
    row: TaskTimeRow;
    editable: boolean;
    onEdit: (row: TaskTimeRow, band: ScenarioBand, value: string) => void;
    onRevert: (row: TaskTimeRow) => void;
    onUseResearch: (row: TaskTimeRow) => void;
}

function TaskRow({ row, editable, onEdit, onRevert, onUseResearch }: TaskRowProps) {
    const errorId = `${useId()}-error`;
    const href = safeUrl(row.sourceUrl);
    const typicalHours = row.hoursPerMinute === undefined ? undefined : row.hoursPerMinute * row.shown.typical;
    const researchHours = row.hoursPerMinute === undefined ? undefined : row.hoursPerMinute * row.research.typical;

    return (
        <tr className={cn("align-top", row.pending && "bg-accent/50")}>
            <td
                className={cn(
                    CELL,
                    "pr-300 pl-300",
                    row.custom && "shadow-[inset_2px_0_0_var(--color-primary)]",
                )}
            >
                <span className="flex flex-col gap-100">
                    <span className={cn(BODY, "font-semibold text-foreground")}>{row.task}</span>
                    <span className={cn(SMALL, "text-muted-foreground")}>
                        {row.category} · {grainLabel(row.grain)}
                    </span>
                    {row.error ? (
                        <span id={errorId} className={cn(SMALL, "text-destructive")}>
                            {row.error}
                        </span>
                    ) : row.pending ? (
                        <span className={cn(SMALL, "font-semibold text-primary")}>Changed, not saved</span>
                    ) : row.saved ? (
                        <span className={cn(SMALL, "font-semibold text-primary")}>Your times</span>
                    ) : null}
                </span>
            </td>
            {BANDS.map(({ band, label }) => (
                <td key={band} className={cn(CELL, "px-200 text-right")}>
                    <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`${row.task}, ${label} minutes`}
                        aria-invalid={row.error ? true : undefined}
                        aria-describedby={row.error ? errorId : undefined}
                        value={row.draft?.[band] ?? formatMinutes(row.current[band])}
                        disabled={!editable}
                        onChange={(event) => onEdit(row, band, event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape" && row.draft) {
                                event.preventDefault();
                                onRevert(row);
                            }
                        }}
                        className={cn(INPUT, "w-[72px] text-right")}
                    />
                    {!sameMinutes(row.shown[band], row.research[band]) && (
                        <span className={cn(SMALL, "mt-100 block text-muted-foreground tabular-nums")}>
                            Research {formatMinutes(row.research[band])}
                        </span>
                    )}
                </td>
            ))}
            <td className={cn(CELL, "px-200 text-right tabular-nums")}>
                {typicalHours === undefined ? (
                    <span className={cn(SMALL, "inline-block pt-200-nudge text-muted-foreground")}>No activity</span>
                ) : (
                    <span className="flex flex-col gap-100 pt-200-nudge">
                        <span className={cn(BODY, "font-semibold text-foreground")}>{hours(typicalHours)}</span>
                        {!sameMinutes(row.shown.typical, row.research.typical) && (
                            <span className={cn(SMALL, "text-muted-foreground")}>Research {hours(researchHours)}</span>
                        )}
                    </span>
                )}
            </td>
            <td className={cn(CELL, SMALL, "px-300")}>
                <span className="flex flex-col gap-100 pt-200-nudge">
                    {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className={LINK}>
                            <span>{row.source ?? href}</span>
                            <ExternalLink className="icon-size-100 shrink-0 translate-y-[1px]" aria-hidden="true" />
                            <span className="sr-only">(opens in a new tab)</span>
                        </a>
                    ) : (
                        <span className="text-foreground">{row.source ?? "No source given"}</span>
                    )}
                    {row.confidence && <span className="text-muted-foreground">{row.confidence} confidence</span>}
                </span>
            </td>
            <td className={cn(CELL, "pr-200 pl-100 text-right")}>
                {row.custom && (
                    <button
                        type="button"
                        disabled={!editable}
                        onClick={() => onUseResearch(row)}
                        className={cn(SMALL, GHOST, "mt-100")}
                    >
                        Use research<span className="sr-only"> times for {row.task}</span>
                    </button>
                )}
            </td>
        </tr>
    );
}

interface FigureProps {
    label: string;
    value: string;
    detail?: string;
}

function Figure({ label, value, detail }: FigureProps) {
    return (
        <div className="flex flex-col gap-100">
            <dt className={cn(SMALL, "text-muted-foreground")}>{label}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-200">
                <span className="text-[length:var(--text-600)] leading-600 font-semibold text-foreground tabular-nums">
                    {value}
                </span>
                {detail && <span className={cn(SMALL, "text-muted-foreground")}>{detail}</span>}
            </dd>
        </div>
    );
}

function changeOnResearch(research: number | undefined, shown: number | undefined): string | undefined {
    if (research === undefined || shown === undefined || research <= 0) return undefined;
    const change = shown / research - 1;
    if (Math.abs(change) < 0.0005) return "Same as the research";
    return `${change > 0 ? "+" : "−"}${formatKpi(Math.abs(change), "percent")} on the research`;
}

/**
 * The minutes each task would take without Copilot, for each effort
 * scenario, as the research has them and as this organisation sets them.
 * Typed times show what they do to the hours straight away; saving applies
 * them to every page, for everyone who opens the app.
 */
export function TimePerTaskStage() {
    const taskTimes = useTaskTimes();
    const tasksResult = useFilteredQuery(modelTaskTimes());
    const hoursResult = useFilteredQuery(hoursPerMinuteSource);

    const [drafts, setDrafts] = useState<Drafts>({});
    const [category, setCategory] = useState<string>();
    const [search, setSearch] = useState("");
    const [view, setView] = useState<View>("all");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const [notice, setNotice] = useState<string>();

    const modelTasks = useMemo(
        () => (tasksResult.data?.status === "success" ? readModelTaskTimes(tasksResult.data.table) : undefined),
        [tasksResult.data],
    );
    const hoursPerMinute = useMemo(
        () => (hoursResult.data?.status === "success" ? readHoursPerMinute(hoursResult.data.table) : undefined),
        [hoursResult.data],
    );
    const rows = useMemo(
        () => (modelTasks ? sortRows(buildRows(modelTasks, taskTimes.saved, drafts, hoursPerMinute)) : undefined),
        [modelTasks, taskTimes.saved, drafts, hoursPerMinute],
    );

    const categories = useMemo(() => {
        const counts = new Map<string, number>();
        for (const row of rows ?? []) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
        return [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, count]) => ({ value, label: value, count }));
    }, [rows]);
    const selected = category && categories.some((choice) => choice.value === category) ? category : undefined;
    const visible = useMemo(
        () => (rows ? filterRows(rows, { category: selected, search, customOnly: view === "custom" }) : undefined),
        [rows, selected, search, view],
    );

    const changes = useMemo(() => (rows ? pendingChanges(rows) : []), [rows]);
    const pending = rows?.filter((row) => row.pending).length ?? 0;
    const invalid = rows?.filter((row) => row.error).length ?? 0;
    const custom = rows?.filter((row) => row.custom).length ?? 0;
    const resettable = rows?.some((row) => row.saved || row.draft) ?? false;
    const totals = useMemo(() => (rows ? typicalHours(rows) : {}), [rows]);
    const editable = taskTimes.status === "ready" && !saving;
    const changed = changedLine(lastChange(taskTimes.saved));

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(undefined), 6000);
        return () => clearTimeout(timer);
    }, [notice]);

    useEffect(() => {
        if (pending === 0) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [pending]);

    const edit = (row: TaskTimeRow, band: ScenarioBand, value: string) => {
        setNotice(undefined);
        setDrafts((current) => ({ ...current, [row.key]: { ...(current[row.key] ?? toDraft(row.current)), [band]: value } }));
    };
    const revert = (row: TaskTimeRow) =>
        setDrafts((current) => {
            const next = { ...current };
            delete next[row.key];
            return next;
        });
    const putResearchBack = (row: TaskTimeRow) => {
        setNotice(undefined);
        setDrafts((current) => ({ ...current, [row.key]: toDraft(row.research) }));
    };
    const putResearchBackForAll = () => {
        setNotice(undefined);
        const next: Record<string, ReturnType<typeof toDraft>> = {};
        for (const row of rows ?? []) if (row.saved) next[row.key] = toDraft(row.research);
        setDrafts(next);
    };
    const discard = () => {
        setDrafts({});
        setSaveError(undefined);
    };
    const commit = async () => {
        if (!editable || invalid > 0 || changes.length === 0) return;
        setSaving(true);
        setSaveError(undefined);
        try {
            await taskTimes.save(changes);
            setDrafts({});
            setNotice(`Saved ${tasks(changes.length)}. Every page now uses these times.`);
        } catch (error) {
            setSaveError(describe(error));
        } finally {
            setSaving(false);
        }
    };

    const clearFilters = () => {
        setSearch("");
        setCategory(undefined);
        setView("all");
    };

    const toolbar = (
        <div className="flex flex-wrap items-center gap-200">
            <label className="relative flex items-center">
                <span className="sr-only">Find a task</span>
                <Search
                    className="pointer-events-none absolute left-200 icon-size-200 text-muted-foreground"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    value={search}
                    placeholder="Find a task"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setSearch(event.target.value)}
                    className={cn(INPUT, "w-[200px] pl-700")}
                />
            </label>
            {categories.length > 1 && (
                <ChoiceMenu
                    label="Task Category"
                    allLabel="All task categories"
                    choices={categories}
                    value={selected}
                    onChange={setCategory}
                />
            )}
            <SegmentedControl
                label="Show"
                value={view}
                onChange={setView}
                options={[
                    { id: "all", label: "All tasks" },
                    {
                        id: "custom",
                        label: custom > 0 ? `Your times (${formatKpi(custom, "whole")})` : "Your times",
                        disabled: custom === 0 && view !== "custom",
                        hint: custom === 0 ? "Every task uses the research times" : undefined,
                    },
                ]}
            />
        </div>
    );

    const loading = taskTimes.status === "loading" || tasksResult.isLoading || (!rows && !tasksResult.data);

    return (
        <Section
            id={stageAnchor("time-per-task")}
            title="Time per task"
            description="How long each task would take someone without Copilot. Every hours and value figure in the app is worked out from these minutes."
            actions={rows && rows.length > 0 ? toolbar : undefined}
        >
            <p className={cn(BODY, "max-w-[85ch] text-muted-foreground")}>
                Each task starts at the research figures ValueLens ships with. Change any of them to match how long the
                work takes in your organisation, then save: every page in the app uses them straight away. The Value
                page's Conservative, Typical and Optimistic scenarios each use their own column.
            </p>

            {taskTimes.status === "unavailable" && (
                <p role="status" className={cn(SMALL, "rounded-md bg-secondary px-300 py-200 text-foreground")}>
                    Saved times can't be read right now, so every figure uses the research times and nothing can be
                    changed. {taskTimes.unavailableReason}
                </p>
            )}

            {tasksResult.data?.status === "error" ? (
                <QueryError message={tasksResult.data.error.message} onRetry={tasksResult.refetch} />
            ) : loading || !rows || !visible ? (
                <QueryLoading className="h-[480px]" />
            ) : rows.length === 0 ? (
                <QueryEmpty
                    title="No task times in the model"
                    description="The semantic model's Human Time Estimates table is empty. It ships with the ValueLens template, so check that the model was deployed from it."
                />
            ) : (
                <>
                    <dl className="grid grid-cols-1 gap-400 border-y border-border py-400 sm:grid-cols-3">
                        <Figure label="Hours at Typical effort, research times" value={hours(totals.research)} />
                        <Figure
                            label={pending > 0 ? "With the times shown, not saved yet" : "With the times in use"}
                            value={hours(totals.shown)}
                            detail={changeOnResearch(totals.research, totals.shown)}
                        />
                        <Figure
                            label="Tasks on your own times"
                            value={`${formatKpi(custom, "whole")} of ${formatKpi(rows.length, "whole")}`}
                        />
                    </dl>
                    {hoursResult.data?.status === "error" && (
                        <p role="alert" className={cn(SMALL, "text-destructive")}>
                            The hours couldn't be worked out, but the times can still be changed:{" "}
                            {hoursResult.data.error.message}
                        </p>
                    )}

                    {visible.length === 0 ? (
                        <div className="flex flex-col items-start gap-300">
                            <QueryEmpty
                                className="self-stretch"
                                title={view === "custom" && !search && !selected ? "Every task uses the research" : "No tasks match"}
                                description={
                                    view === "custom" && !search && !selected
                                        ? "No task has times of its own. Change a task's minutes under All tasks, then save."
                                        : "Nothing matches the search and filters set above."
                                }
                            />
                            <button type="button" onClick={clearFilters} className={SECONDARY}>
                                Show every task
                            </button>
                        </div>
                    ) : (
                        <div className="relative max-xl:overflow-x-auto">
                            <table className="w-full min-w-[920px] border-collapse text-left">
                                <caption className="sr-only">
                                    Minutes each task would take without Copilot, for each effort scenario, with the
                                    hours they give and the research behind them
                                </caption>
                                <thead className={cn(SMALL, "sticky top-0 z-[1] bg-background text-muted-foreground")}>
                                    <tr>
                                        <th scope="col" className={cn(HEAD, "pr-300 pl-300")}>
                                            Task Breakdown
                                        </th>
                                        {BANDS.map(({ band, label }) => (
                                            <th key={band} scope="col" className={cn(HEAD, "w-[96px] px-200 text-right")}>
                                                <span className="block text-foreground">{label}</span>
                                                <span className="block font-normal">minutes</span>
                                            </th>
                                        ))}
                                        <th scope="col" className={cn(HEAD, "w-[120px] px-200 text-right")}>
                                            <span className="block text-foreground">Hours</span>
                                            <span className="block font-normal">at Typical</span>
                                        </th>
                                        <th scope="col" className={cn(HEAD, "px-300")}>
                                            <span className="block text-foreground">Research</span>
                                            <span className="block font-normal">and confidence</span>
                                        </th>
                                        <th scope="col" className={cn(HEAD, "w-[1%] pr-200")}>
                                            <span className="sr-only">Put back</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visible.map((row) => (
                                        <TaskRow
                                            key={row.key}
                                            row={row}
                                            editable={editable}
                                            onEdit={edit}
                                            onRevert={revert}
                                            onUseResearch={putResearchBack}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <p role="status" aria-live="polite" className="sr-only">
                        {notice}
                    </p>
                    {(pending > 0 || saveError || notice) && (
                        <div
                            role="group"
                            aria-label="Changes to the task times"
                            className="sticky bottom-0 z-10 -mx-700 flex flex-wrap items-center gap-x-400 gap-y-200 border-t border-border bg-background px-700 py-300"
                        >
                            <span className={cn(BODY, "mr-auto text-foreground")}>
                                {pending > 0
                                    ? invalid > 0
                                        ? `${tasks(pending)} changed. Fix ${invalid === 1 ? "the one" : `the ${invalid}`} marked in red to save.`
                                        : `${tasks(pending)} changed, not saved yet.`
                                    : notice}
                            </span>
                            {saveError && (
                                <span role="alert" className={cn(SMALL, "basis-full text-destructive")}>
                                    Couldn't save: {saveError}
                                </span>
                            )}
                            {pending > 0 && (
                                <>
                                    <button
                                        type="button"
                                        disabled={saving}
                                        onClick={discard}
                                        className={cn(SECONDARY, "whitespace-nowrap")}
                                    >
                                        Discard changes
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!editable || invalid > 0 || changes.length === 0}
                                        onClick={() => void commit()}
                                        className={cn(PRIMARY, "whitespace-nowrap")}
                                    >
                                        {saving ? "Saving…" : "Save for everyone"}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    <div className="flex flex-wrap items-start justify-between gap-300">
                        <p className={cn(SMALL, "max-w-[85ch] text-muted-foreground")}>
                            {changed && <>{changed} </>}
                            Anyone who can open this app can change these, for everyone. The Power BI report keeps the
                            research figures. Hours cover all the activity ValueLens holds; Cowork's come from its own Task
                            Breakdown, so they aren't counted here and don't change.
                        </p>
                        <button
                            type="button"
                            disabled={!editable || !resettable}
                            onClick={putResearchBackForAll}
                            className={SECONDARY}
                        >
                            Use research for every task
                        </button>
                    </div>
                </>
            )}
        </Section>
    );
}
