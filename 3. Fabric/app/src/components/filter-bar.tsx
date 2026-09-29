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
    DATE_PRESET_LABELS,
    defaultFilters,
    FILTER_LABELS,
    formatDateRange,
    isFilterActive,
    presetRange,
    summariseSelection,
    type Audience,
    type FilterKey,
    type Licence,
} from "@/lib/filters";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { cn } from "@/lib/utils";
import { FilterMenu } from "./filter-menu";
import { SegmentedControl } from "./segmented-control";

const LICENCE_OPTIONS: { id: Licence; label: string }[] = [
    { id: "all", label: "All" },
    { id: "licensed", label: "Licensed" },
    { id: "unlicensed", label: "Unlicensed" },
];

const AUDIENCE_OPTIONS: { id: Audience; label: string }[] = [
    { id: "all", label: "All" },
    { id: "copilot", label: "Copilot chat" },
    { id: "agents", label: "Agents" },
];

const optionClass = (selected: boolean) =>
    cn(
        "flex w-full items-center justify-between gap-300 rounded-md px-300 py-200 text-left text-[length:var(--text-300)] leading-300 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        selected ? "bg-accent font-semibold text-accent-foreground" : "text-foreground hover:bg-secondary",
    );

function DateFilter() {
    const { filters, setFilters, options } = useFilterContext();
    const first = options?.firstDate;
    const last = options?.lastDate;
    const [from, setFrom] = useState(filters.dateRange?.from ?? first ?? "");
    const [to, setTo] = useState(filters.dateRange?.to ?? last ?? "");
    const fromId = useId();
    const toId = useId();

    const range = filters.dateRange;
    const summary = !range
        ? DATE_PRESET_LABELS.all
        : range.preset === "custom"
          ? formatDateRange(range.from, range.to)
          : DATE_PRESET_LABELS[range.preset];
    const presets = first && last ? availablePresets(first, last) : [];
    const customValid = Boolean(from && to && from <= to);

    return (
        <FilterMenu label={FILTER_LABELS.dateRange} summary={summary} active={Boolean(range)}>
            {(close) => (
                <div className="flex flex-col gap-300">
                    <div className="flex flex-col gap-100">
                        <button
                            type="button"
                            aria-pressed={!range}
                            className={optionClass(!range)}
                            onClick={() => {
                                setFilters((current) => ({ ...current, dateRange: undefined }));
                                close();
                            }}
                        >
                            {DATE_PRESET_LABELS.all}
                            {!range && <Check className="icon-size-200" aria-hidden="true" />}
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
                                        setFilters((current) => ({ ...current, dateRange: presetRange(preset, first!, last!) }));
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
    );
}

interface MultiSelectFilterProps {
    filterKey: "organizations" | "agentTypes";
    allLabel: string;
    noun: string;
    choices: readonly string[] | undefined;
}

function MultiSelectFilter({ filterKey, allLabel, noun, choices }: MultiSelectFilterProps) {
    const { filters, setFilters } = useFilterContext();
    const [search, setSearch] = useState("");
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
            label={FILTER_LABELS[filterKey]}
            summary={summariseSelection(selected, allLabel, noun)}
            active={selected.length > 0}
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
                        <ul className="flex flex-col" aria-label={FILTER_LABELS[filterKey]}>
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

interface LabelledSegmentProps<T extends string> {
    label: string;
    options: readonly { id: T; label: string }[];
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
 * The slicers for the current destination, kept in reach at the top of the
 * canvas. Filters persist between destinations; one that is set but does not
 * apply here is called out rather than silently dropped.
 */
export function FilterBar({ destinationLabel }: { destinationLabel: string }) {
    const { filters, setFilters, options, optionsError, applicable } = useFilterContext();
    const refreshing = useIsRefreshing();

    const has = (key: FilterKey) => applicable.includes(key);
    const anyActive = (Object.keys(FILTER_LABELS) as FilterKey[]).some((key) => isFilterActive(filters, key));
    const notApplied = (Object.keys(FILTER_LABELS) as FilterKey[]).filter(
        (key) => isFilterActive(filters, key) && !has(key),
    );

    return (
        <div
            role="group"
            aria-label="Filters"
            className="sticky top-0 z-10 -mx-700 flex flex-wrap items-center gap-x-400 gap-y-200 border-b border-border bg-background px-700 py-300"
        >
            {has("dateRange") && <DateFilter />}
            {has("organizations") && (
                <MultiSelectFilter
                    filterKey="organizations"
                    allLabel="All organizations"
                    noun="organizations"
                    choices={options?.organizations}
                />
            )}
            {has("licence") && (
                <LabelledSegment
                    label={FILTER_LABELS.licence}
                    options={LICENCE_OPTIONS}
                    value={filters.licence}
                    onChange={(licence) => setFilters((current) => ({ ...current, licence }))}
                />
            )}
            {has("audience") && (
                <LabelledSegment
                    label={FILTER_LABELS.audience}
                    options={AUDIENCE_OPTIONS}
                    value={filters.audience}
                    onChange={(audience) => setFilters((current) => ({ ...current, audience }))}
                />
            )}
            {has("agentTypes") && (
                <MultiSelectFilter
                    filterKey="agentTypes"
                    allLabel="All agent types"
                    noun="agent types"
                    choices={options?.agentTypes}
                />
            )}

            <div className="ml-auto flex items-center gap-300">
                {refreshing && (
                    <span role="status" className="flex items-center gap-100 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        <LoaderCircle className="icon-size-200 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        Updating
                    </span>
                )}
                {anyActive && (
                    <button
                        type="button"
                        onClick={() => setFilters(defaultFilters)}
                        className="flex h-[32px] items-center gap-100 rounded-md px-300 text-[length:var(--text-200)] font-semibold text-primary transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        <X className="icon-size-200" aria-hidden="true" />
                        Clear filters
                    </button>
                )}
            </div>

            {(notApplied.length > 0 || optionsError) && (
                <p className="flex basis-full items-center gap-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">
                    <Info className="icon-size-200 shrink-0" aria-hidden="true" />
                    {optionsError
                        ? "Filter choices didn't load, so only the date presets are available."
                        : `${notApplied.map((key) => FILTER_LABELS[key]).join(" and ")} ${notApplied.length > 1 ? "filters are set but don't" : "filter is set but doesn't"} apply to ${destinationLabel}.`}
                </p>
            )}
        </div>
    );
}
