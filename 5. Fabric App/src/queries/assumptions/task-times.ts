//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { addQueryDefinitions, daxString } from "@/lib/dax-filters";
import { readNumber, readText, toRecords } from "@/lib/summary-row";
import { daxNumber } from "../consumption/commercial-terms";
import { connection } from "../shared";
import { HOURS_MEASURES } from "./hours-measures";
import taskTimesQuery from "./task-times.dax?raw";

/** How long one unit of a task would take someone without Copilot, in minutes, for each effort scenario. */
export interface TaskTime {
    /** Used by the Conservative scenario. */
    low: number;
    /** Used by the Typical scenario. */
    typical: number;
    /** Used by the Optimistic scenario. */
    high: number;
}

/** A task's times as saved in the app, replacing the model's for that task. */
export interface TaskTimeOverride extends TaskTime {
    /** The behaviour, exactly as the model's `Human Time Estimates` table names it. */
    task: string;
}

/** The longest time the app accepts for one unit of a task: a working day. */
export const MINUTES_MAX = 480;

export const SCENARIO_BANDS = ["low", "typical", "high"] as const satisfies readonly (keyof TaskTime)[];
export type ScenarioBand = (typeof SCENARIO_BANDS)[number];

const MEASURE_TABLE = "Chat + Agent Interactions (Audit Logs)";
const ROOT = HOURS_MEASURES[0];

/** The root measure's minutes lookup: everything from `VAR _min =` up to the next variable. */
const MINUTES_LOOKUP = /(VAR _min =)([\s\S]*?)(?=\n[ \t]*VAR _mult\b)/;

const REFERENCE = /\[([^\]]+)\]/g;
const OWN_MEASURE = /\bMEASURE\s+(?:'(?:[^']|'')*'|[A-Za-z_][\w ]*)?\s*\[([^\]]+)\]/gi;

function references(text: string): Set<string> {
    return new Set(Array.from(text.matchAll(REFERENCE), (match) => match[1]));
}

const measureNames = new Set(HOURS_MEASURES.map((measure) => measure.name));

/** Each hours measure and the other hours measures it reads. */
const chain: ReadonlyMap<string, readonly string[]> = new Map(
    HOURS_MEASURES.map((measure) => [
        measure.name,
        [...references(measure.expression)].filter((name) => name !== measure.name && measureNames.has(name)),
    ]),
);

function quoteTable(table: string): string {
    return `'${table.replace(/'/g, "''")}'`;
}

/** The root measure with its minutes lookup rewritten from the model's own: `model` is that lookup's DAX. */
function rootWithMinutes(minutes: (model: string) => string): string {
    const match = MINUTES_LOOKUP.exec(ROOT.expression);
    if (!match) throw new Error(`The template's ${ROOT.name} no longer reads minutes as expected; refresh hours-measures.ts.`);
    return ROOT.expression.replace(MINUTES_LOOKUP, (_all, head: string) => `${head}${minutes(match[2])}`);
}

function overrideMinutes(overrides: readonly TaskTimeOverride[]): (model: string) => string {
    const branches = overrides.map(
        (override) =>
            `${daxString(override.task)}, SWITCH(_scn, "Conservative", ${daxNumber(override.low)}, "Optimistic", ${daxNumber(override.high)}, ${daxNumber(override.typical)})`,
    );
    return (model) =>
        [
            "",
            "            VAR _task = 'Behavior Value Map'[Behavior]",
            `            VAR _model =${model.replace(/\s+$/, "")}`,
            "            RETURN",
            "                SWITCH(",
            "                    _task,",
            ...branches.map((branch) => `                    ${branch},`),
            "                    _model",
            "                )",
        ].join("\n");
}

function usable(override: TaskTimeOverride): boolean {
    return (
        override.task.length > 0 &&
        SCENARIO_BANDS.every((band) => Number.isFinite(override[band]) && override[band] >= 0)
    );
}

/** True when the query shows a figure the task times change, so it should wait for them. */
export function readsTaskTimes(query: string): boolean {
    return [...references(query)].some((name) => chain.has(name));
}

/**
 * Values a ValueLens query at the task times saved in the app.
 *
 * The measure that reads the minutes is redefined for the query, with each
 * saved task's minutes in front of the model's, and so is every measure
 * between it and the query: a model measure reads the model's measures
 * whatever the query defines, so `[AI Assisted Value]` only moves when it and
 * everything beneath it are query measures too. Measures the query already
 * defines are its own and are left alone. Returns the query unchanged when no
 * time is saved or it shows no hours.
 */
export function withTaskTimes(query: string, overrides: readonly TaskTimeOverride[]): string {
    const saved = overrides.filter(usable).sort((a, b) => a.task.localeCompare(b.task));
    if (saved.length === 0 || !readsTaskTimes(query)) return query;

    const own = new Set(Array.from(query.matchAll(OWN_MEASURE), (match) => match[1]));
    const wanted = new Set<string>();
    const visit = (name: string) => {
        if (own.has(name) || wanted.has(name) || !chain.has(name)) return;
        wanted.add(name);
        chain.get(name)?.forEach(visit);
    };
    references(query).forEach(visit);
    if (wanted.size === 0) return query;

    const definitions = HOURS_MEASURES.filter((measure) => wanted.has(measure.name)).map((measure) => {
        const expression = measure === ROOT ? rootWithMinutes(overrideMinutes(saved)) : measure.expression;
        return `MEASURE ${quoteTable(measure.table)}[${measure.name}] =\n${expression.replace(/^\n|\s+$/g, "")}`;
    });
    return addQueryDefinitions(query, definitions);
}

/**
 * Reads typed minutes: blank is "not set", anything else that is not a
 * number comes back as NaN, and a number is kept to one decimal place.
 */
export function parseMinutes(text: string): number | undefined {
    const cleaned = text.trim().replace(/\s*min(?:ute)?s?\.?$/i, "");
    if (cleaned === "") return undefined;
    if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return Number.NaN;
    return Math.round(Number(cleaned) * 10) / 10;
}

/** Why a task's times cannot be used, or undefined when they can. */
export function validateTaskTime(time: Partial<Record<ScenarioBand, number>>): string | undefined {
    const values = SCENARIO_BANDS.map((band) => time[band]);
    if (values.some((value) => value === undefined)) return "Enter all three times.";
    if (values.some((value) => !Number.isFinite(value))) return "Enter minutes as a number.";
    if (values.some((value) => (value as number) < 0 || (value as number) > MINUTES_MAX)) {
        return `Enter minutes between 0 and ${MINUTES_MAX}.`;
    }
    const [low, typical, high] = values as number[];
    if (low > typical || typical > high) return "Keep Conservative at or below Typical, and Typical at or below Optimistic.";
    return undefined;
}

/** True when two sets of times are the same to the tenth of a minute. */
export function sameTaskTime(a: TaskTime, b: TaskTime): boolean {
    return SCENARIO_BANDS.every((band) => Math.round(a[band] * 10) === Math.round(b[band] * 10));
}

export const TASK_COLUMNS = {
    task: "[Task]",
    category: "[Category]",
    grain: "[Grain]",
    low: "[Low]",
    typical: "[Typical]",
    high: "[High]",
    source: "[Source]",
    sourceUrl: "[Source URL]",
    confidence: "[Confidence]",
} as const;

/** A task the model times, with the researched minutes and the source behind them. */
export interface ModelTaskTime {
    task: string;
    category: string;
    /** "Per Turn" counts each prompt; "Per Resource" each file or page Copilot reads. */
    grain: string;
    research: TaskTime;
    source?: string;
    sourceUrl?: string;
    confidence?: string;
}

/** The model's task times, skipping any row without a name or a full set of minutes. */
export function readModelTaskTimes(table: QueryTable): ModelTaskTime[] {
    const tasks: ModelTaskTime[] = [];
    for (const row of toRecords(table)) {
        const task = readText(row, TASK_COLUMNS.task);
        const low = readNumber(row, TASK_COLUMNS.low);
        const typical = readNumber(row, TASK_COLUMNS.typical);
        const high = readNumber(row, TASK_COLUMNS.high);
        if (!task || low === undefined || typical === undefined || high === undefined) continue;
        tasks.push({
            task,
            category: readText(row, TASK_COLUMNS.category) ?? "Other",
            grain: readText(row, TASK_COLUMNS.grain) ?? "Per Turn",
            research: { low, typical, high },
            source: readText(row, TASK_COLUMNS.source),
            sourceUrl: readText(row, TASK_COLUMNS.sourceUrl),
            confidence: readText(row, TASK_COLUMNS.confidence),
        });
    }
    return tasks;
}

/**
 * Every task the model times, with its researched minutes for each scenario
 * and the source behind them: the model's `Human Time Estimates` table.
 */
export function modelTaskTimes() {
    return { connection, query: taskTimesQuery };
}

export const HOURS_PER_MINUTE = "Hours Per Minute";

/**
 * Hours per minute of each task's time, keyed by {@link taskTimeKey}. Activity
 * no task is mapped to comes back without a name and is left out: it is
 * never valued.
 */
export function readHoursPerMinute(table: QueryTable): Map<string, number> {
    const behavior = table.columns.find((column) => column.name.endsWith("[Behavior]"))?.name;
    const hours = `[${HOURS_PER_MINUTE}]`;
    const byTask = new Map<string, number>();
    if (!behavior) return byTask;
    for (const row of toRecords(table)) {
        const task = readText(row, behavior);
        const value = readNumber(row, hours);
        if (task && value !== undefined) byTask.set(taskTimeKey(task), value);
    }
    return byTask;
}

/** How tasks are matched: by name, ignoring case and outer spaces, as DAX compares them. */
export function taskTimeKey(task: string): string {
    return task.trim().toLowerCase();
}

/**
 * How many expert-equivalent hours each minute of a task's time is worth in
 * the activity ValueLens holds: the root measure with every task timed at one
 * minute, Cowork left out as `[Expert Equivalent Hours]` leaves it out. Hours
 * are linear in the minutes, so a task's hours at any time are this times
 * those minutes, which lets the page show what a change does before it is
 * saved.
 */
export function taskHoursPerMinute() {
    const measure = `MEASURE ${quoteTable(MEASURE_TABLE)}[ValueLens ${HOURS_PER_MINUTE}] =\n${rootWithMinutes(() => " 1").replace(/^\n|\s+$/g, "")}`;
    const query = addQueryDefinitions(
        [
            "EVALUATE",
            "SUMMARIZECOLUMNS(",
            "    'Behavior Value Map'[Behavior],",
            `    ${daxString(HOURS_PER_MINUTE)},`,
            "        CALCULATE(",
            `            [ValueLens ${HOURS_PER_MINUTE}],`,
            `            KEEPFILTERS(${quoteTable(MEASURE_TABLE)}[Agent Filter (Normalized)] <> "Cowork")`,
            "        )",
            ")",
        ].join("\n"),
        [measure],
    );
    return { connection, query };
}
