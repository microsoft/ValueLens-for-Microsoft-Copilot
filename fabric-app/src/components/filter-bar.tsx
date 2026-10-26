//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, useState } from "react";
import { Check, Info, LoaderCircle, X } from "lucide-react";
import { useFilterContext } from "@/hooks/filter.context";
import {
    availablePresets,
    AUDIENCE_LABELS,
    AUDIENCE_VALUES,
    DATE_PRESET_LABELS,
    differsFromTenantDefault,
    FILTER_KEYS,
    filterLabel,
    formatDateRange,
    isFilterInEffect,
    isTenantDefaultRange,
    presetRange,
    shownDateRange,
    tenantDefaultFilters,
    summariseSelection,
    type Audience,
    type FilterKey,
    type Licence,
} from "@/lib/filters";
import { describeOrgAttribute } from "@/lib/org-attribute";
import { menuOptionClass as optionClass } from "@/lib/menu-option";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { FilterMenu } from "./filter-menu";
import { SegmentedControl } from "./segmented-control";

const LICENCE_OPTIONS: { id: Licence; label: string }[] = [
    { id: "all", label: "All" },
    { id: "licensed", label: "Licensed" },
    { id: "unlicensed", label: "Unlicensed" },
];

function DateFilter() {
    const { filters, setFilters, options } = useFilterContext();
    const first = options?.firstDate;
    const last = options?.lastDate;
    const fromId = useId();
    const toId = useId();

    const tenantDefault = isTenantDefaultRange(filters.dateRange);
    // The dates the filter covers: the tenant default resolves to the last 12 weeks only on a large tenant.
    const range = shownDateRange(filters.dateRange, options);
    const [from, setFrom] = useState(range?.from ?? first ?? "");
    const [to, setTo] = useState(range?.to ?? last ?? "");
    // The tenant default before the options say whether the tenant is large.
    const undecided = tenantDefault && !range && options?.largeTenant !== false;
    const summary = undecided
        ? "Default dates"
        : !range
          ? DATE_PRESET_LABELS.all
          : range.preset === "custom" || tenantDefault
            ? `${tenantDefault ? `${DATE_PRESET_LABELS[range.preset]} · ` : ""}${formatDateRange(range.from, range.to)}`
            : DATE_PRESET_LABELS[range.preset];
    const presets = first && last ? availablePresets(first, last) : [];
    const customValid = Boolean(from && to && from <= to);
    const allDates = !range && !undecided;

    return (
        <div className="flex items-center gap-200">
            <FilterMenu label={filterLabel("dateRange", "")} summary={summary} active={Boolean(range)}>
                {(close) => (
                    <div className="flex flex-col gap-300">
                        <div className="flex flex-col gap-100">
                            <button
                                type="button"
                                aria-pressed={allDates}
                                className={optionClass(allDates)}
                                onClick={() => {
                                    // On a small tenant the default already covers every date, so keep it and its queries.
                                    if (!allDates) setFilters((current) => ({ ...current, dateRange: undefined }));
                                    close();
                                }}
                            >
                                {DATE_PRESET_LABELS.all}
                                {allDates && <Check className="icon-size-200" aria-hidden="true" />}
                            </button>
                            {presets.map((preset) => {
                                const selected = range?.preset === preset;
                                return (
                                    <button
                                        key={preset}
                                        type="button"
                                        aria-pressed={selected}
                                        className={optionClass(selected)}
                                        onClick={() => {
                                            // Picking the window the default already shows keeps the default and its queries.
                                            if (!(selected && tenantDefault)) {
                                                setFilters((current) => ({ ...current, dateRange: presetRange(preset, first!, last!) }));
                                            }
                                            close();
                                        }}
                                    >
                                        {DATE_PRESET_LABELS[preset]}
                                        {selected && <Check className="icon-size-200" aria-hidden="true" />}
                                    </button>
                                );
                            })}
                        </div>

                        <form
                            className="flex flex-col gap-200 border-t border-border pt-300"
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (!customValid) return;
                                setFilters((current) => ({ ...current, dateRange: { preset: "custom", from, to } }));
                                close();
                            }}
                        >
                            <span className="text-[length:var(--text-200)] leading-200 font-semibold text-foreground">
                                {DATE_PRESET_LABELS.custom}
                            </span>
                            <div className="grid grid-cols-2 gap-200">
                                <label htmlFor={fromId} className="flex flex-col gap-100 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                    From
                                    <input
                                        id={fromId}
                                        type="date"
                                        value={from}
                                        min={first}
                                        max={last}
                                        onChange={(event) => setFrom(event.target.value)}
                                        className="h-[32px] rounded-md border border-input bg-card px-200 text-[length:var(--text-300)] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                                    />
                                </label>
                                <label htmlFor={toId} className="flex flex-col gap-100 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                    To
                                    <input
                                        id={toId}
                                        type="date"
                                        value={to}
                                        min={first}
                                        max={last}
                                        onChange={(event) => setTo(event.target.value)}
                                        className="h-[32px] rounded-md border border-input bg-card px-200 text-[length:var(--text-300)] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                                    />
                                </label>
                            </div>
                            <button
                                type="submit"
                                disabled={!customValid}
                                className="h-[32px] rounded-md bg-primary px-300 text-[length:var(--text-300)] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Apply range
                            </button>
                            {first && last && (
                                <p className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                    Activity is loaded for {formatDateRange(first, last)}.
                                </p>
                            )}
                        </form>
                    </div>
                )}
            </FilterMenu>
            {tenantDefault && range && (
                <>
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">Default for large organizations</span>
                    <button
                        type="button"
                        onClick={() => setFilters((current) => ({ ...current, dateRange: undefined }))}
                        className="h-[32px] rounded-md px-200 text-[length:var(--text-200)] font-semibold text-primary transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        Show all dates
                    </button>
                </>
            )}
        </div>
    );
}

interface MultiSelectFilterProps {
    filterKey: "organizations" | "agentTypes" | "agentNames";
    label: string;
    allLabel: string;
    noun: string;
    choices: readonly string[] | undefined;
    /** What the choices are values of, such as the org column. A search typed among them ends when it changes. */
    choicesOf?: string;
}

function MultiSelectFilter({ filterKey, label, allLabel, noun, choices, choicesOf }: MultiSelectFilterProps) {
    const { filters, setFilters, requestFilterChoices } = useFilterContext();
    const [search, setSearch] = useState("");
    const [searchedOf, setSearchedOf] = useState(choicesOf);
    if (searchedOf !== choicesOf) {
        setSearchedOf(choicesOf);
        setSearch("");
    }
    const selected = filters[filterKey];
    const searchId = useId();

    const visible = useMemo(() => {
        const term = search.trim().toLowerCase();
        return (choices ?? []).filter((choice) => !term || choice.toLowerCase().includes(term));
    }, [choices, search]);

    const toggle = (choice: string) =>
        setFilters((current) => {
            const values = current[filterKey];
            return {
                ...current,
                [filterKey]: values.includes(choice) ? values.filter((value) => value !== choice) : [...values, choice],
            };
        });

    return (
        <FilterMenu
            label={label}
            summary={summariseSelection(selected, allLabel, noun)}
            active={selected.length > 0}
            onOpen={requestFilterChoices}
        >
            {() => (
                <div className="flex flex-col gap-200">
                    {(choices?.length ?? 0) > 8 && (
                        <>
                            <label htmlFor={searchId} className="sr-only">
                                Search {noun}
                            </label>
                            <input
                                id={searchId}
                                type="search"
                                data-autofocus
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={`Search ${noun}`}
                                className="h-[32px] rounded-md border border-input bg-card px-300 text-[length:var(--text-300)] text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                            />
                        </>
                    )}
                    {choices === undefined ? (
                        <p className="px-200 py-200 text-[length:var(--text-300)] text-muted-foreground">Loading {noun}…</p>
                    ) : visible.length === 0 ? (
                        <p className="px-200 py-200 text-[length:var(--text-300)] text-muted-foreground">No {noun} match.</p>
                    ) : (
                        <ul className="flex flex-col" aria-label={label}>
                            {visible.map((choice) => (
                                <li key={choice}>
                                    <label className="flex cursor-pointer items-center gap-300 rounded-md px-200 py-200 text-[length:var(--text-300)] leading-300 text-foreground hover:bg-secondary">
                                        <input
                                            type="checkbox"
                                            checked={selected.includes(choice)}
                                            onChange={() => toggle(choice)}
                                            className="icon-size-200 shrink-0 accent-primary"
                                        />
                                        <span className="truncate">{choice}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    )}
                    {selected.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setFilters((current) => ({ ...current, [filterKey]: [] }))}
                            className="self-start rounded-md px-200 py-100 text-[length:var(--text-200)] font-semibold text-primary hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                            Show all {noun}
                        </button>
                    )}
                </div>
            )}
        </FilterMenu>
    );
}

/**
 * Picks which column of the customer's org data the breakdowns group by —
 * department, function, location, whatever their export carried — and so
 * which values the filter beside it offers.
 */
function GroupByFilter() {
    const { filters, setFilters, orgAttributes, orgAttribute, requestFilterChoices } = useFilterContext();

    return (
        <FilterMenu label="Group by" summary={orgAttribute.label} active={false} onOpen={requestFilterChoices}>
            {(close) => (
                <div className="flex flex-col gap-200">
                    <p className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        Charts and tables that break down by team use this column from your org data.
                    </p>
                    <ul className="flex flex-col gap-100" aria-label="Group by">
                        {orgAttributes.map((column) => {
                            const selected = column === filters.orgAttribute;
                            return (
                                <li key={column}>
                                    <button
                                        type="button"
                                        aria-pressed={selected}
                                        className={optionClass(selected)}
                                        onClick={() => {
                                            if (!selected) {
                                                // The old values belong to the old column.
                                                setFilters((current) => ({ ...current, orgAttribute: column, organizations: [] }));
                                            }
                                            close();
                                        }}
                                    >
                                        {describeOrgAttribute(column).label}
                                        {selected && <Check className="icon-size-200" aria-hidden="true" />}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </FilterMenu>
    );
}

interface LabelledSegmentProps<T extends string> {
    label: string;
    options: readonly { id: T; label: string; disabled?: boolean; hint?: string }[];
    value: T;
    onChange: (value: T) => void;
}

function LabelledSegment<T extends string>({ label, options, value, onChange }: LabelledSegmentProps<T>) {
    return (
        <div className="flex items-center gap-200">
            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground" aria-hidden="true">
                {label}
            </span>
            <SegmentedControl label={label} options={options} value={value} onChange={onChange} />
        </div>
    );
}

/**
 * The slicers for the current destination, the last row of the toolbar,
 * kept in reach at the top of the page as it scrolls. Filters persist between destinations; one that is set but does not
 * apply here is called out rather than silently dropped.
 */
export function FilterBar({ destinationLabel }: { destinationLabel: string }) {
    const { filters, setFilters, options, optionsError, applicable, orgAttribute, orgAttributes, orgValues } =
        useFilterContext();
    const refreshing = useIsRefreshing();

    const has = (key: FilterKey) => applicable.includes(key);
    // Reset filters returns to where the tenant starts: the last 12 weeks on a large tenant, every date on a small one.
    const changed = FILTER_KEYS.some((key) => differsFromTenantDefault(filters, key, options));
    // The tenant's default dates aren't the user's choice, so they go unmentioned where they don't apply.
    const notApplied = FILTER_KEYS.filter(
        (key) =>
            isFilterInEffect(filters, key, options) &&
            !(key === "dateRange" && isTenantDefaultRange(filters.dateRange)) &&
            !has(key),
    );

    // Offer Cowork even before the tenant has any, so the option is visible,
    // but only make it selectable once the data holds Cowork activity.
    const audienceOptions = (Object.keys(AUDIENCE_LABELS) as Audience[]).map((id) => {
        const missing =
            id !== "all" &&
            options !== undefined &&
            !options.activities.includes(AUDIENCE_VALUES[id]) &&
            filters.audience !== id;
        return {
            id,
            label: AUDIENCE_LABELS[id],
            disabled: missing,
            hint: missing ? `No ${AUDIENCE_LABELS[id]} activity in this data yet` : undefined,
        };
    });

    return (
        <div
            role="group"
            aria-label="Filters"
            data-print="hide"
            className="flex flex-wrap items-center gap-x-400 gap-y-200 py-300"
        >
            {has("dateRange") && <DateFilter />}
            {has("organizations") && orgAttributes.length > 1 && <GroupByFilter />}
            {has("organizations") && (
                // Not keyed by the column: once the org columns load, they may change it while its menu is open.
                <MultiSelectFilter
                    filterKey="organizations"
                    label={orgAttribute.label}
                    allLabel={`All ${orgAttribute.plural}`}
                    noun={orgAttribute.plural}
                    choices={orgValues}
                    choicesOf={orgAttribute.column}
                />
            )}
            {has("licence") && (
                <LabelledSegment
                    label={filterLabel("licence", "")}
                    options={LICENCE_OPTIONS}
                    value={filters.licence}
                    onChange={(licence) => setFilters((current) => ({ ...current, licence }))}
                />
            )}
            {has("audience") && (
                <LabelledSegment
                    label={filterLabel("audience", "")}
                    options={audienceOptions}
                    value={filters.audience}
                    onChange={(audience) => setFilters((current) => ({ ...current, audience }))}
                />
            )}
            {has("agentTypes") && (
                <MultiSelectFilter
                    filterKey="agentTypes"
                    label={filterLabel("agentTypes", "")}
                    allLabel="All agent types"
                    noun="agent types"
                    choices={options?.agentTypes}
                />
            )}
            {has("agentNames") && (
                <MultiSelectFilter
                    filterKey="agentNames"
                    label={filterLabel("agentNames", "")}
                    allLabel="All agents"
                    noun="agents"
                    choices={options?.agentNames}
                />
            )}

            <div className="ml-auto flex items-center gap-300">
                {refreshing && (
                    <span role="status" className="flex items-center gap-100 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        <LoaderCircle className="icon-size-200 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        Updating
                    </span>
                )}
                {changed && (
                    <button
                        type="button"
                        onClick={() => setFilters(tenantDefaultFilters)}
                        className="flex h-[32px] items-center gap-100 rounded-md px-300 text-[length:var(--text-200)] font-semibold text-primary transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        <X className="icon-size-200" aria-hidden="true" />
                        Reset filters
                    </button>
                )}
            </div>

            {(notApplied.length > 0 || optionsError) && (
                <p className="flex basis-full items-center gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                    <Info className="icon-size-200 shrink-0" aria-hidden="true" />
                    {optionsError
                        ? "Filter choices didn't load, so only the date presets are available."
                        : `${notApplied.map((key) => filterLabel(key, orgAttribute.label)).join(" and ")} ${notApplied.length > 1 ? "filters are set but don't" : "filter is set but doesn't"} apply to ${destinationLabel}.`}
                </p>
            )}
        </div>
    );
}
