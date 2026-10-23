//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { dateBetween, treatAs } from "./dax-filters";
import { DEFAULT_ORG_ATTRIBUTE, orgColumnRef } from "./org-attribute";

/**
 * The report's slicers, reduced to the handful that recur across its pages.
 * Each destination declares which of them apply to it; a stage can opt out of
 * one when it already splits by that dimension itself.
 */
export type FilterKey = "dateRange" | "organizations" | "licence" | "audience" | "agentTypes" | "agentNames";

const AUDIT = "'Chat + Agent Interactions (Audit Logs)'";

export type DatePreset = "all" | "4w" | "8w" | "12w" | "custom";
export type Audience = "all" | "copilot" | "agents" | "cowork";
export type Licence = "all" | "licensed" | "unlicensed";

export interface DateRange {
    preset: Exclude<DatePreset, "all">;
    /** Inclusive ISO `yyyy-mm-dd`. */
    from: string;
    /** Inclusive ISO `yyyy-mm-dd`. */
    to: string;
    relative?: undefined;
}

/**
 * The date filter every session starts with: the last 12 weeks to the last
 * day with activity on a large tenant, and every date on a small one. Each
 * query works out both the tenant's size and the window in the model (see
 * {@link tenantDefaultDates}), so no query waits for the filter options'
 * dates. Its dates, once the options are known, come from
 * {@link shownDateRange}; the state itself never changes as they arrive, so
 * no query is asked again.
 */
export interface TenantDefaultRange {
    preset: "12w";
    relative: true;
}

/** What the date filter holds: fixed dates, or the tenant's default window. */
export type DateFilterValue = DateRange | TenantDefaultRange;

export interface FilterState {
    /** `undefined` means the whole loaded window. */
    dateRange: DateFilterValue | undefined;
    /**
     * The org column to group and filter by. The provider resolves it against
     * the columns the model actually has before anything reads it.
     */
    orgAttribute: string;
    /** Values of `orgAttribute`; empty means all of them. */
    organizations: string[];
    licence: Licence;
    audience: Audience;
    /** Empty means every agent type. */
    agentTypes: string[];
    /** Empty means every agent. */
    agentNames: string[];
}

export const defaultFilters: FilterState = {
    dateRange: undefined,
    orgAttribute: DEFAULT_ORG_ATTRIBUTE,
    organizations: [],
    licence: "all",
    audience: "all",
    agentTypes: [],
    agentNames: [],
};

export const TENANT_DEFAULT_RANGE: TenantDefaultRange = { preset: "12w", relative: true };

/**
 * The filters a session starts with, and what Reset filters returns to: the
 * tenant's default date window, and nothing else narrowed. `defaultFilters`
 * is the same with every date.
 */
export const tenantDefaultFilters: FilterState = { ...defaultFilters, dateRange: TENANT_DEFAULT_RANGE };

export function isTenantDefaultRange(range: DateFilterValue | undefined): range is TenantDefaultRange {
    return range?.relative === true;
}

/**
 * More people than this with activity make a tenant large, so its date filter
 * starts at the last 12 weeks rather than every date. It is the line the
 * installer sizes a tenant "More than 10,000" by. Measured at 20,000 people,
 * a three-month window took the Adoption summary from 5.8 s to about 4 s and
 * the org-to-person drill from about 10.5 s to about 9 s, and the gain grows
 * with the tenant; a tenant of 10,000 or fewer keeps every date, where the
 * queries are quick enough already.
 */
export const LARGE_TENANT_PEOPLE = 10_000;

/** The days the large-tenant default covers: 12 weeks, as the "Last 12 weeks" preset. */
export const TENANT_DEFAULT_DAYS = 84;

/**
 * The last day with activity, read past every filter, as the filter options
 * read it and the "Last 12 weeks" preset anchors on.
 */
export const LAST_ACTIVITY_DATE = `CALCULATE(MAX(${AUDIT}[ActivityDate]), REMOVEFILTERS())`;

/**
 * The people with activity, read past every filter: the person key the app
 * counts users by, without blanks. The filter options read the same count, so
 * the filter bar and the queries agree on the tenant's size.
 */
export const PEOPLE_WITH_ACTIVITY = `CALCULATE(DISTINCTCOUNTNOBLANK(${AUDIT}[Audit_UserId]), REMOVEFILTERS())`;

/** Whether `people` with activity make a tenant large, as {@link tenantDefaultDates} decides it in the model. */
export function isLargeTenant(people: number): boolean {
    return people > LARGE_TENANT_PEOPLE;
}

/**
 * The tenant's default date window as a DAX filter on `column`: the last
 * {@link TENANT_DEFAULT_DAYS} days to the last day with activity when more
 * than {@link LARGE_TENANT_PEOPLE} people have activity, and every date,
 * blank included, otherwise. Both are worked out in the query, so it needn't
 * wait for the filter options.
 */
export function tenantDefaultDates(column: string = FILTER_COLUMNS.date): string {
    return [
        `VAR __TenantLastDate = ${LAST_ACTIVITY_DATE}`,
        `VAR __TenantIsLarge = ${PEOPLE_WITH_ACTIVITY} > ${LARGE_TENANT_PEOPLE}`,
        `RETURN FILTER(ALL(${column}), NOT __TenantIsLarge || (${column} > __TenantLastDate - ${TENANT_DEFAULT_DAYS} && ${column} <= __TenantLastDate))`,
    ].join("\n    ");
}

/** What the filter options say about the tenant's dates and size. */
export interface TenantDates {
    firstDate?: string;
    lastDate?: string;
    /** `undefined` when the options couldn't say. */
    largeTenant?: boolean;
}

/**
 * The dates a date filter covers, as the filter bar shows them: fixed dates as
 * they are, and the tenant default as the last 12 weeks to the last day with
 * activity on a large tenant. `undefined` means every date — no filter, the
 * default on a small tenant, or the default while the options load.
 */
export function shownDateRange(range: DateFilterValue | undefined, tenant: TenantDates | undefined): DateRange | undefined {
    if (!isTenantDefaultRange(range)) return range;
    if (!tenant?.largeTenant || !tenant.lastDate) return undefined;
    return presetRange(range.preset, tenant.firstDate ?? tenant.lastDate, tenant.lastDate);
}

/**
 * Whether a filter narrows what's shown, for the notes that say a card isn't
 * filtered by it. The tenant default narrows only once the options say the
 * tenant is large; a query still applies it, see {@link isFilterActive}.
 */
export function isFilterInEffect(state: FilterState, key: FilterKey, tenant: TenantDates | undefined): boolean {
    if (key === "dateRange" && isTenantDefaultRange(state.dateRange)) return tenant?.largeTenant === true;
    return isFilterActive(state, key);
}

/**
 * Whether a filter differs from where the tenant starts, so Reset filters has
 * something to undo. On a small tenant "All dates" is the default too.
 */
export function differsFromTenantDefault(state: FilterState, key: FilterKey, tenant: TenantDates | undefined): boolean {
    if (key !== "dateRange") return isFilterActive(state, key);
    if (isTenantDefaultRange(state.dateRange)) return false;
    return state.dateRange !== undefined || tenant?.largeTenant !== false;
}

export const FILTER_KEYS: readonly FilterKey[] = [
    "dateRange",
    "organizations",
    "licence",
    "audience",
    "agentTypes",
    "agentNames",
];

export const FILTER_LABELS: Record<FilterKey, string> = {
    dateRange: "Date",
    organizations: "Organization",
    licence: "License",
    audience: "Activity",
    agentTypes: "Agent type",
    agentNames: "Agent",
};

/** A filter's name, with the org filter named after the attribute in use. */
export function filterLabel(key: FilterKey, orgLabel: string): string {
    return key === "organizations" ? orgLabel : FILTER_LABELS[key];
}

/** The model columns each slicer filters, as the report's own slicers do. */
export const FILTER_COLUMNS = {
    date: "'Calendar'[Date]",
    licence: `${AUDIT}[Environment]`,
    audience: `${AUDIT}[Agent Filter (Normalized)]`,
    agentType: "'Agents 365'[Agent Type Label]",
    agentName: `${AUDIT}[AgentName]`,
} as const;

/** The values of the report's Activity column behind each audience. */
export const AUDIENCE_VALUES: Record<Exclude<Audience, "all">, string> = {
    copilot: "Copilot",
    agents: "Agents",
    cowork: "Cowork",
};

/** How the filter bar names each Activity option. */
export const AUDIENCE_LABELS: Record<Audience, string> = {
    all: "All",
    copilot: "Copilot chat",
    agents: "Agents",
    cowork: "Cowork",
};

/** A group of people some stages show side by side, one card each. */
export type Cohort = "licensed" | "unlicensed" | "agents" | "cowork";

/**
 * The group the filter bar's Activity and License filters pick out among the
 * `cohorts` a stage shows, or `"all"` when they pick none of them. Activity
 * wins because it names the narrower group, and a filter the destination
 * doesn't offer is ignored. Activity = Copilot chat is never a cohort.
 */
export function selectedCohort<C extends Cohort>(
    state: FilterState,
    applicable: readonly FilterKey[],
    cohorts: readonly C[],
): C | "all" {
    const shown = (value: string): value is C => (cohorts as readonly string[]).includes(value);
    if (applicable.includes("audience") && shown(state.audience)) return state.audience;
    if (applicable.includes("licence") && shown(state.licence)) return state.licence;
    return "all";
}

/**
 * The Activity filter's label when it picks a group none of a stage's side-by-side
 * `cohorts` covers, so the stage can say why another card is highlighted.
 */
export function unshownActivity(
    state: FilterState,
    applicable: readonly FilterKey[],
    cohorts: readonly Cohort[],
): string | undefined {
    if (!applicable.includes("audience") || state.audience === "all") return undefined;
    return (cohorts as readonly string[]).includes(state.audience) ? undefined : AUDIENCE_LABELS[state.audience];
}

/**
 * Whether the License filter picks unlicensed people on a stage that offers it.
 * Cowork runs only under a Copilot license, so Cowork views are empty by
 * definition then, rather than because of the data.
 */
export function unlicensedOnly(state: FilterState, applicable: readonly FilterKey[]): boolean {
    return applicable.includes("licence") && state.licence === "unlicensed";
}

/**
 * Whether a query takes a filter at all. The tenant default always counts:
 * each query decides in the model whether it narrows, so the query is the
 * same before and after the filter options load.
 */
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
        case "agentNames":
            return state.agentNames.length > 0;
    }
}

/**
 * The DAX filter argument for one active filter on the ValueLens model, as
 * the report's own slicer applies it. Call only for an active filter.
 */
export function filterExpression(state: FilterState, key: FilterKey): string {
    switch (key) {
        case "dateRange":
            return dateFilter(state.dateRange!, FILTER_COLUMNS.date);
        case "organizations":
            return treatAs(orgColumnRef(state.orgAttribute), state.organizations);
        case "licence":
            return treatAs(FILTER_COLUMNS.licence, [state.licence === "licensed" ? "Licensed" : "Unlicensed"]);
        case "audience":
            return treatAs(FILTER_COLUMNS.audience, [AUDIENCE_VALUES[state.audience as Exclude<Audience, "all">]]);
        case "agentTypes":
            return treatAs(FILTER_COLUMNS.agentType, state.agentTypes);
        case "agentNames":
            return treatAs(FILTER_COLUMNS.agentName, state.agentNames);
    }
}

/** A date filter on `column`, the tenant default worked out in the ValueLens model. */
export function dateFilter(range: DateFilterValue, column: string): string {
    return isTenantDefaultRange(range) ? tenantDefaultDates(column) : dateBetween(column, range.from, range.to);
}

/** DAX filter arguments for the active filters among `keys`. */
export function filterExpressions(state: FilterState, keys: readonly FilterKey[]): string[] {
    return keys.filter((key) => isFilterActive(state, key)).map((key) => filterExpression(state, key));
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
