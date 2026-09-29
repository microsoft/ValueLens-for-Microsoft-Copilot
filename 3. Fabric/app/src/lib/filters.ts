//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { dateBetween, treatAs } from "./dax-filters";

/**
 * The report's slicers, reduced to the handful that recur across its pages.
 * Each destination declares which of them apply to it; a stage can opt out of
 * one when it already splits by that dimension itself.
 */
export type FilterKey = "dateRange" | "organizations" | "licence" | "audience" | "agentTypes";

export type DatePreset = "all" | "4w" | "8w" | "12w" | "custom";
export type Audience = "all" | "copilot" | "agents";
export type Licence = "all" | "licensed" | "unlicensed";

export interface DateRange {
    preset: Exclude<DatePreset, "all">;
    /** Inclusive ISO `yyyy-mm-dd`. */
    from: string;
    /** Inclusive ISO `yyyy-mm-dd`. */
    to: string;
}

export interface FilterState {
    /** `undefined` means the whole loaded window. */
    dateRange: DateRange | undefined;
    /** Empty means every organization. */
    organizations: string[];
    licence: Licence;
    audience: Audience;
    /** Empty means every agent type. */
    agentTypes: string[];
}

export const defaultFilters: FilterState = {
    dateRange: undefined,
    organizations: [],
    licence: "all",
    audience: "all",
    agentTypes: [],
};

export const FILTER_LABELS: Record<FilterKey, string> = {
    dateRange: "Date",
    organizations: "Organization",
    licence: "License",
    audience: "Activity",
    agentTypes: "Agent type",
};

const AUDIT = "'Chat + Agent Interactions (Audit Logs)'";

/** The model columns each slicer filters, as the report's own slicers do. */
export const FILTER_COLUMNS = {
    date: "'Calendar'[Date]",
    organization: "'Chat + Agent Org Data'[Organization]",
    licence: `${AUDIT}[Environment]`,
    audience: `${AUDIT}[Agent Filter (Normalized)]`,
    agentType: "'Agents 365'[Agent Type Label]",
} as const;

/** Whether a filter narrows the data at all. */
export function isFilterActive(state: FilterState, key: FilterKey): boolean {
    switch (key) {
        case "dateRange":
            return state.dateRange !== undefined;
        case "organizations":
            return state.organizations.length > 0;
        case "licence":
            return state.licence !== "all";
        case "audience":
            return state.audience !== "all";
        case "agentTypes":
            return state.agentTypes.length > 0;
    }
}

/** DAX filter arguments for the active filters among `keys`. */
export function filterExpressions(state: FilterState, keys: readonly FilterKey[]): string[] {
    const expressions: string[] = [];
    for (const key of keys) {
        if (!isFilterActive(state, key)) continue;
        switch (key) {
            case "dateRange":
                expressions.push(dateBetween(FILTER_COLUMNS.date, state.dateRange!.from, state.dateRange!.to));
                break;
            case "organizations":
                expressions.push(treatAs(FILTER_COLUMNS.organization, state.organizations));
                break;
            case "licence":
                expressions.push(treatAs(FILTER_COLUMNS.licence, [state.licence === "licensed" ? "Licensed" : "Unlicensed"]));
                break;
            case "audience":
                expressions.push(treatAs(FILTER_COLUMNS.audience, [state.audience === "agents" ? "Agents" : "Copilot"]));
                break;
            case "agentTypes":
                expressions.push(treatAs(FILTER_COLUMNS.agentType, state.agentTypes));
                break;
        }
    }
    return expressions;
}

const PRESET_WEEKS: Record<Exclude<DatePreset, "all" | "custom">, number> = { "4w": 4, "8w": 8, "12w": 12 };

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
    all: "All dates",
    "4w": "Last 4 weeks",
    "8w": "Last 8 weeks",
    "12w": "Last 12 weeks",
    custom: "Custom range",
};

function addDays(iso: string, days: number): string {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The trailing-week presets worth offering for a data window: only those
 * shorter than the window itself, since a longer one would select everything.
 */
export function availablePresets(firstDate: string, lastDate: string): Exclude<DatePreset, "all" | "custom">[] {
    const span = daysBetween(firstDate, lastDate) + 1;
    return (Object.keys(PRESET_WEEKS) as Exclude<DatePreset, "all" | "custom">[]).filter(
        (preset) => PRESET_WEEKS[preset] * 7 < span,
    );
}

/**
 * Resolves a trailing preset against the last date that has data — not today,
 * because exports land in batches and "last 4 weeks" should never be empty.
 */
export function presetRange(
    preset: Exclude<DatePreset, "all" | "custom">,
    firstDate: string,
    lastDate: string,
): DateRange {
    const from = addDays(lastDate, -(PRESET_WEEKS[preset] * 7 - 1));
    return { preset, from: from < firstDate ? firstDate : from, to: lastDate };
}

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "12 May – 6 Jul 2026" */
export function formatDateRange(from: string, to: string): string {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
    return `${(sameYear ? shortDate : longDate).format(start)} – ${longDate.format(end)}`;
}

/** Summarises a multi-select for its trigger button. */
export function summariseSelection(selected: readonly string[], allLabel: string, noun: string): string {
    if (selected.length === 0) return allLabel;
    if (selected.length === 1) return selected[0];
    return `${selected.length} ${noun}`;
}
