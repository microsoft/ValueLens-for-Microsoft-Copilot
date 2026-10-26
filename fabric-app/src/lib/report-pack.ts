//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { destinations, isPackable, type Destination, type DestinationId, type StageId } from "@/components/destinations";
import { dataToSuffix } from "@/lib/download";
import { FILTER_KEYS, type FilterKey } from "@/lib/filters";
import { PAGE_SOURCES, type FreshnessSource } from "@/lib/freshness";

/**
 * A named, ordered set of stages from any destinations, read top to bottom as
 * one page and exported as one PDF or deck. Built-in packs ship with the app;
 * saved ones are kept in the app's database and shared by everyone.
 */
export interface ReportPack {
    id: string;
    name: string;
    description?: string;
    stages: StageId[];
    /** Shipped with the app: it can be copied but not edited or deleted. */
    builtIn?: boolean;
    updatedBy?: string;
    updatedAt?: string;
}

export const MAX_PACK_NAME = 80;
export const MAX_PACK_DESCRIPTION = 280;

/** The packs a fresh install starts with, for the usual audiences. */
export const BUILT_IN_PACKS: readonly ReportPack[] = [
    {
        id: "builtin-exec-pre-read",
        name: "Exec pre-read",
        description: "The headline story, and what it costs against what it's worth",
        stages: ["the-bottom-line", "is-it-growing", "where-it-is-landing", "what-needs-attention", "cost-vs-value"],
        builtIn: true,
    },
    {
        id: "builtin-finance-weekly",
        name: "Finance weekly",
        description: "Credits used, budget runway, and cost against value",
        stages: ["consumption-overview", "budget-runway", "cost-vs-value"],
        builtIn: true,
    },
    {
        id: "builtin-adoption-review",
        name: "Adoption review",
        description: "Who started, who stayed, and who to license next",
        stages: ["activation", "adoption", "habit-formation", "trend-heatmap", "leaderboard", "habit-licence"],
        builtIn: true,
    },
];

/** Where each stage lives, for the stages a pack can hold. */
const STAGE_HOME = new Map<string, Destination>(
    destinations
        .filter(isPackable)
        .flatMap((destination) => destination.stages.map((stage) => [stage.id, destination] as const)),
);

/** The destination a stage belongs to. */
export function stageDestination(id: StageId): Destination {
    return STAGE_HOME.get(id)!;
}

export function isStageId(value: unknown): value is StageId {
    return typeof value === "string" && STAGE_HOME.has(value);
}

/** A stage's own label, for lists and slide titles. */
export function stageLabel(id: StageId): string {
    const stage = stageDestination(id).stages.find((candidate) => candidate.id === id);
    return stage?.label ?? id;
}

/** The stages, de-duplicated, keeping only ids the app knows, in the order given. */
export function cleanStages(stages: readonly unknown[]): StageId[] {
    const seen = new Set<StageId>();
    for (const stage of stages) if (isStageId(stage)) seen.add(stage);
    return [...seen];
}

function text(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().slice(0, max).trim();
    return trimmed || undefined;
}

/**
 * A pack read from storage or an editor: unknown and repeated stages are
 * dropped, the name trimmed and capped. Undefined when there is no name or no
 * stage left to show.
 */
export function parsePack(raw: unknown): ReportPack | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as Record<string, unknown>;
    const id = text(source.id, 64);
    const name = text(source.name, MAX_PACK_NAME);
    let stages: unknown = source.stages;
    if (typeof stages === "string") {
        try {
            stages = JSON.parse(stages);
        } catch {
            return undefined;
        }
    }
    if (!id || !name || !Array.isArray(stages)) return undefined;
    const cleaned = cleanStages(stages);
    if (cleaned.length === 0) return undefined;
    return {
        id,
        name,
        description: text(source.description, MAX_PACK_DESCRIPTION),
        stages: cleaned,
        updatedBy: text(source.updatedBy, 256),
        updatedAt: source.updatedAt instanceof Date ? source.updatedAt.toISOString() : text(source.updatedAt, 64),
    };
}

/** A new pack's id; the store keeps it as given. */
export function newPackId(): string {
    return crypto.randomUUID();
}

/** A copy of a pack under a new id, to rename and save as one's own. */
export function copyOfPack(pack: ReportPack): ReportPack {
    return {
        id: newPackId(),
        name: `${pack.name} (copy)`.slice(0, MAX_PACK_NAME),
        description: pack.description,
        stages: [...pack.stages],
    };
}

function pageOrder(id: StageId): number {
    return stageDestination(id).stages.findIndex((stage) => stage.id === id);
}

/** A run of consecutive pack stages from one destination, shown under its palette and slicers. */
export interface PackRun {
    destination: Destination;
    stages: StageId[];
}

/**
 * The pack's stages grouped into consecutive runs per destination, in pack
 * order, so a destination that appears twice is shown twice. A screen draws
 * its stages in page order, so a run also ends where the pack goes back up
 * its destination's page. Stages whose
 * destination this install doesn't have are returned as `missing`.
 */
export function packRuns(
    stages: readonly StageId[],
    available: readonly Destination[],
): { runs: PackRun[]; missing: StageId[] } {
    const reachable = new Set<DestinationId>(available.map((destination) => destination.id));
    const runs: PackRun[] = [];
    const missing: StageId[] = [];
    for (const stage of stages) {
        const destination = stageDestination(stage);
        if (!reachable.has(destination.id)) {
            missing.push(stage);
            continue;
        }
        const last = runs.at(-1);
        if (last && last.destination.id === destination.id && pageOrder(stage) > pageOrder(last.stages.at(-1)!)) {
            last.stages.push(stage);
        } else runs.push({ destination, stages: [stage] });
    }
    return { runs, missing };
}

/** Every slicer any of the runs responds to, in the filter bar's order. */
export function packFilters(runs: readonly PackRun[]): FilterKey[] {
    const wanted = new Set<FilterKey>(runs.flatMap((run) => run.destination.filters as readonly FilterKey[]));
    return FILTER_KEYS.filter((key) => wanted.has(key));
}

/** Every source behind the runs, in first-seen order, for the freshness line. */
export function packSources(runs: readonly PackRun[]): FreshnessSource[] {
    return [...new Set(runs.flatMap((run) => PAGE_SOURCES[run.destination.id]))];
}

/** A destination read as a pack of all of its stages, for exporting the page on its own. */
export function destinationPack(destination: Destination): ReportPack {
    return {
        id: `page-${destination.id}`,
        name: destination.label,
        stages: destination.stages.map((stage) => stage.id),
        builtIn: true,
    };
}

export { dataToSuffix };

/**
 * The export's file name: the pack's name, then the date the data runs to
 * when that is known, as in `exec-pre-read-data-to-2026-07-06.pptx`.
 */
export function exportFileName(name: string, dataTo: string | undefined, extension: string): string {
    const slug =
        name
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80)
            .replace(/-+$/, "") || "report";
    return `${slug}${dataToSuffix(dataTo)}.${extension}`;
}

/**
 * The date an export's data runs to: the earliest last date among its sources,
 * since the export is only complete up to the source that stops first.
 */
export function earliestDate(dates: readonly (string | null | undefined)[]): string | undefined {
    const days = dates.flatMap((date) => date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? []);
    return days.length > 0 ? days.sort()[0] : undefined;
}
