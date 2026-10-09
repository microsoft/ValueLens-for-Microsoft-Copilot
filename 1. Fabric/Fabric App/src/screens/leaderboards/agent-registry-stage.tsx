//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, useRef, useState, type Ref } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@/components/vega-visual";
import { ChevronDown } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { Headlined, HEADLINE_SPACE } from "@/components/headlined";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { heatDomain, heatRenderer } from "@/lib/heat";
import { isAbsent } from "@/lib/optional-sources";
import { prefersReducedMotion } from "@/lib/scroll-to-anchor";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { formatCell, textCell } from "@/lib/tree-grid";
import { cn } from "@/lib/utils";
import {
    agentActivitySummary,
    agentLeaderboard,
    agentUsage,
    toAgentEntries,
    type AgentEntry,
} from "@/queries/agents";
import { AGENT_USAGE_HEADLINE } from "./headlines";

const SMALL = "text-[length:var(--text-200)] leading-200";
const BODY = "text-[length:var(--text-300)] leading-300";

const IN_REGISTRY = "In Registry";

/** Leaderboard columns only the Agent 365 registry fills in. */
const REGISTRY_COLUMNS: ReadonlySet<string> = new Set(["Creator", "Available In", "Lifecycle", "Adoption"]);

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function formatDay(value: unknown): string | null {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? dayFormat.format(new Date(`${value}T00:00:00Z`))
        : null;
}

function isUnused(row: Row): boolean {
    return row.Users === 0;
}

/** Usage an agent doesn't have in the selection stays blank, as it does in the report. */
function usageCell(format: (value: unknown) => string | null) {
    return (value: unknown, row: Row) => (isUnused(row) ? null : format(value));
}

/**
 * One grid row per agent. Missing usage is stored as the column's lowest
 * value rather than a blank, because the grid sorts blanks first when
 * sorting high to low; the cells still render blank.
 */
function toRow(entry: AgentEntry): Row {
    return {
        _id: entry.key,
        Agent: entry.name,
        Type: entry.type ?? "",
        Creator: entry.creator ?? "",
        Users: entry.users,
        "Orgs Reached": entry.orgsReached,
        Sessions: entry.sessions,
        "Return Rate": entry.returnRate ?? 0,
        "Last Activity": entry.lastActivity ?? "",
        "Available In": entry.surfaces?.join(", ") ?? entry.features ?? "",
        Lifecycle: entry.lifecycle ?? "",
        Adoption: entry.adoption ?? "",
        [IN_REGISTRY]: entry.inRegistry,
    };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

interface PickerOption {
    key: string;
    label: string;
}

/**
 * The detail card's agent list, alphabetical, used agents first. The
 * registry repeats names ("Agent" five times), so a repeated name carries
 * its creator or type, then a number if that still doesn't tell them apart.
 */
function pickerGroups(entries: readonly AgentEntry[]): { used: PickerOption[]; unused: PickerOption[] } {
    const nameCount = new Map<string, number>();
    for (const entry of entries) nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1);
    const labels = entries.map((entry) =>
        (nameCount.get(entry.name) ?? 0) > 1 ? `${entry.name} · ${entry.creator ?? entry.type ?? "no creator"}` : entry.name,
    );
    const labelCount = new Map<string, number>();
    for (const label of labels) labelCount.set(label, (labelCount.get(label) ?? 0) + 1);

    const seen = new Map<string, number>();
    const options = entries.map((entry, index) => {
        const label = labels[index];
        if ((labelCount.get(label) ?? 0) < 2) return { entry, label };
        const repeat = (seen.get(label) ?? 0) + 1;
        seen.set(label, repeat);
        return { entry, label: `${label} (${repeat})` };
    });
    options.sort((a, b) => collator.compare(a.label, b.label));

    const toOption = ({ entry, label }: { entry: AgentEntry; label: string }) => ({ key: entry.key, label });
    return {
        used: options.filter(({ entry }) => entry.users > 0).map(toOption),
        unused: options.filter(({ entry }) => entry.users === 0).map(toOption),
    };
}

function describe(entry: AgentEntry): { text: string; supplied: boolean } {
    if (entry.description) return { text: entry.description, supplied: true };
    return entry.inRegistry
        ? { text: "The registry has no description for this agent.", supplied: false }
        : {
              text: "No registry entry matches this agent, so there's no description to show. Its name and usage come from the audit log.",
              supplied: false,
          };
}

interface AgentDetailProps {
    entries: readonly AgentEntry[];
    selected: AgentEntry;
    onSelect: (key: string) => void;
    ref?: Ref<HTMLElement>;
}

/**
 * The report's agent detail card: the selected agent's supplied
 * description, its registry details and its use in the selection. Picking
 * an agent here or selecting its row in the table both change it.
 */
function AgentDetail({ entries, selected, onSelect, ref }: AgentDetailProps) {
    const headingId = useId();
    const selectId = useId();
    const groups = useMemo(() => pickerGroups(entries), [entries]);
    const description = describe(selected);
    const meta = [selected.type, selected.creator].filter(Boolean).join(" · ");
    const used = selected.users > 0;

    const registryFacts = selected.inRegistry
        ? [
              {
                  term: "Available in",
                  detail: selected.surfaces ? (
                      <ul className="flex flex-wrap gap-100">
                          {selected.surfaces.map((surface) => (
                              <li
                                  key={surface}
                                  className={`rounded-full bg-secondary px-200 py-[2px] ${SMALL} text-secondary-foreground`}
                              >
                                  {surface}
                              </li>
                          ))}
                      </ul>
                  ) : (
                      (selected.features ?? "Not recorded")
                  ),
              },
              { term: "Lifecycle stage", detail: selected.lifecycle ?? "Not recorded" },
              { term: "Adoption", detail: selected.adoption ?? "Not recorded" },
          ]
        : [];

    const usage = [
        { term: "Users", value: formatKpi(selected.users, "whole") },
        { term: "Sessions", value: formatKpi(selected.sessions, "whole") },
        { term: "Sessions / user", value: formatKpi(selected.sessionsPerUser, "rate") },
        { term: "Return rate", value: formatKpi(selected.returnRate, "percent") },
        { term: "Orgs reached", value: formatKpi(selected.orgsReached, "whole") },
        { term: "Last activity", value: formatDay(selected.lastActivity) ?? "—" },
    ];

    return (
        <article
            ref={ref}
            aria-labelledby={headingId}
            className="flex scroll-mt-600 flex-col rounded-xl border border-border bg-card"
        >
            <div className="flex flex-col gap-300 border-b border-border px-500 py-400">
                <h3 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold text-foreground">
                    Agent detail
                </h3>
                <div className="flex flex-col gap-100">
                    <label htmlFor={selectId} className={`${SMALL} text-muted-foreground`}>
                        Agent
                    </label>
                    <div className="relative">
                        <select
                            id={selectId}
                            value={selected.key}
                            onChange={(event) => onSelect(event.target.value)}
                            className={cn(
                                "h-[36px] w-full appearance-none truncate rounded-md border border-input bg-card pr-[36px] pl-300",
                                "text-[length:var(--text-300)] text-foreground hover:bg-secondary",
                                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                            )}
                        >
                            {groups.used.length > 0 && (
                                <optgroup label="Used in this selection">
                                    {groups.used.map((option) => (
                                        <option key={option.key} value={option.key}>
                                            {option.label}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                            {groups.unused.length > 0 && (
                                <optgroup label="Not used in this selection">
                                    {groups.unused.map((option) => (
                                        <option key={option.key} value={option.key}>
                                            {option.label}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                        <ChevronDown
                            className="icon-size-200 pointer-events-none absolute top-1/2 right-300 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                </div>
            </div>

            <div aria-live="polite" className="flex flex-col gap-100 px-500 pt-400">
                <h4 className="text-[length:var(--text-400)] leading-400 font-semibold text-card-foreground [overflow-wrap:anywhere]">
                    {selected.name}
                </h4>
                {meta && <p className={`${SMALL} text-muted-foreground`}>{meta}</p>}
                <p
                    className={cn(
                        "mt-200 max-w-[60ch]",
                        BODY,
                        description.supplied ? "text-card-foreground" : "text-muted-foreground",
                    )}
                >
                    {description.text}
                </p>
            </div>

            {registryFacts.length > 0 && (
                <dl className="flex flex-col gap-300 px-500 pt-400">
                    {registryFacts.map(({ term, detail }) => (
                        <div key={term} className="flex flex-col gap-100">
                            <dt className={`${SMALL} text-muted-foreground`}>{term}</dt>
                            <dd className={`${BODY} text-card-foreground`}>{detail}</dd>
                        </div>
                    ))}
                </dl>
            )}

            <div className="mt-400 flex flex-col gap-300 border-t border-border px-500 py-400">
                <p className={`${SMALL} font-semibold text-foreground`}>In this selection</p>
                {used ? (
                    <dl className="grid grid-cols-2 gap-x-400 gap-y-300 sm:grid-cols-3 xl:grid-cols-2">
                        {usage.map(({ term, value }) => (
                            <div key={term} className="flex flex-col gap-100">
                                <dt className={`${SMALL} text-muted-foreground`}>{term}</dt>
                                <dd className={`${BODY} font-semibold tabular-nums text-card-foreground`}>{value}</dd>
                            </div>
                        ))}
                    </dl>
                ) : (
                    <p className={`${SMALL} text-muted-foreground`}>Nobody used this agent in this selection.</p>
                )}
            </div>

            {selected.registryId && (
                <p className={`border-t border-border px-500 py-300 ${SMALL} text-muted-foreground`}>
                    Registry ID <span className="font-mono break-all text-foreground">{selected.registryId}</span>
                </p>
            )}
        </article>
    );
}

/**
 * The report's Agent Registry table: every agent ranked by its users, the
 * registry's agents alongside the ones only the audit log names, with the
 * detail card for whichever agent is selected.
 */
function AgentLeaderboard({ registry }: { registry: boolean }) {
    const { theme } = useThemeContext();
    const board = agentLeaderboard();
    const result = useFilteredQuery(board);
    const [selectedKey, setSelectedKey] = useState<string>();
    const gridRef = useRef<HTMLDivElement>(null);
    const detailRef = useRef<HTMLElement>(null);

    const entries = useMemo(
        () =>
            result.data?.status === "success"
                ? toAgentEntries(toDataTable(result.data.table, board.columnMetadata))
                : undefined,
        [result.data, board.columnMetadata],
    );
    const rows = useMemo(() => entries?.map(toRow), [entries]);
    const usersDomain = useMemo(
        () => heatDomain((entries ?? []).filter((entry) => entry.users > 0).map((entry) => entry.users)),
        [entries],
    );
    // Until someone picks an agent, and whenever the pick drops out of the selection, the card shows the top agent.
    const selected = entries?.find((entry) => entry.key === selectedKey) ?? entries?.[0];

    const columns: GridColumnDef[] = useMemo(() => {
        const usersCell = heatRenderer({ domain: usersDomain, format: formatCell("whole") });
        const all: GridColumnDef[] = [
            {
                id: "Agent",
                header: "Agent",
                width: 220,
                cellRenderer: (value, row) => {
                    const current = row._id === selected?.key;
                    const name = textCell(value);
                    return (
                        <span
                            data-agent-key={row._id}
                            aria-current={current || undefined}
                            title={name}
                            className={cn("flex min-w-0 items-center gap-200", current && "font-semibold text-primary")}
                        >
                            <span
                                aria-hidden="true"
                                className={cn("size-[6px] shrink-0 rounded-full", current ? "bg-primary" : "bg-transparent")}
                            />
                            <span className="truncate">{name}</span>
                        </span>
                    );
                },
            },
            {
                id: "Type",
                header: "Type",
                width: 170,
                cellRenderer: (value, row) =>
                    row[IN_REGISTRY] === false ? (
                        <span className="text-muted-foreground">{textCell(value)}</span>
                    ) : (
                        textCell(value)
                    ),
            },
            { id: "Creator", header: "Creator", width: 170 },
            {
                id: "Users",
                header: "Users",
                width: 92,
                numericStyling: true,
                filterable: false,
                cellRenderer: (value, row) => (isUnused(row) ? null : usersCell(value, row)),
            },
            {
                id: "Orgs Reached",
                header: "Orgs reached",
                width: 124,
                numericStyling: true,
                filterable: false,
                cellRenderer: usageCell(formatCell("whole")),
            },
            {
                id: "Sessions",
                header: "Sessions",
                width: 104,
                numericStyling: true,
                filterable: false,
                cellRenderer: usageCell(formatCell("whole")),
            },
            {
                id: "Return Rate",
                header: "Return rate",
                width: 116,
                numericStyling: true,
                filterable: false,
                cellRenderer: usageCell(formatCell("percent")),
            },
            {
                id: "Last Activity",
                header: "Last activity",
                width: 128,
                filterable: false,
                cellRenderer: usageCell(formatDay),
            },
            { id: "Available In", header: "Available in", width: 200 },
            { id: "Lifecycle", header: "Lifecycle stage", width: 210 },
            { id: "Adoption", header: "Adoption", width: 170 },
        ];
        return registry ? all : all.filter((column) => !REGISTRY_COLUMNS.has(column.id));
    }, [selected?.key, usersDomain, registry]);

    /** Selects the agent whose row holds `target`; false when `target` isn't in a body row. */
    const pick = (target: EventTarget): boolean => {
        const key =
            target instanceof Element
                ? target.closest("tr")?.querySelector<HTMLElement>("[data-agent-key]")?.dataset.agentKey
                : undefined;
        if (!key) return false;
        setSelectedKey(key);

        // Side by side the card is already in view; stacked under the table it can be off screen.
        const card = detailRef.current;
        const grid = gridRef.current;
        if (card && grid) {
            const cardTop = card.getBoundingClientRect().top;
            const stacked = cardTop >= grid.getBoundingClientRect().bottom;
            if (stacked && (cardTop < 0 || cardTop > window.innerHeight * 0.6)) {
                card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
            }
        }
        return true;
    };

    if (result.data?.status === "error") {
        return <QueryError className="h-[600px]" message={result.data.error.message} onRetry={result.refetch} />;
    }
    if (result.isLoading || !entries || !rows) {
        return <QueryLoading className="h-[600px]" />;
    }
    if (!selected) {
        return (
            <QueryEmpty
                className="h-[600px]"
                title="No agents to rank"
                description={
                    registry
                        ? "Neither the registry nor the audit log has an agent in this selection. Clear a filter, or check that the registry ingestion has run."
                        : "The audit log has no agent use in this selection. Clear a filter to widen it."
                }
            />
        );
    }

    const inUse = entries.filter((entry) => entry.users > 0).length;
    const registered = entries.filter((entry) => entry.inRegistry).length;

    return (
        <div className="grid grid-cols-1 items-start gap-400 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <div
                ref={gridRef}
                className="flex h-[600px] min-w-0 flex-col [&_tbody_tr]:cursor-pointer"
                onClick={(event) => pick(event.target)}
                onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && pick(event.target)) event.preventDefault();
                }}
            >
                <DataGrid
                    columns={columns}
                    data={rows}
                    defaultSort={[{ columnId: "Users", direction: "desc" }]}
                    theme={theme}
                    header={{
                        title: "Agent leaderboard",
                        subtitle: registry
                            ? `${formatKpi(inUse, "whole")} in use, ${formatKpi(registered, "whole")} ` +
                              `registered. Select an agent to see its description.`
                            : `${formatKpi(inUse, "whole")} in use. Select an agent to see its details.`,
                    }}
                />
            </div>
            <AgentDetail ref={detailRef} entries={entries} selected={selected} onSelect={setSelectedKey} />
        </div>
    );
}

/**
 * The agent half of the Leaderboards destination: which agents people use,
 * and what each one is for.
 *
 * Usage is read straight from the audit log, and agents the registry doesn't
 * know are listed by their audit-log names. Where every registered agent sits
 * in its lifecycle, who owns it and who can reach it is Governance's story.
 */
export function AgentRegistryStage() {
    const { theme } = useThemeContext();
    const registry = !isAbsent(useSourceAvailability(), "agentRegistry");

    const activity = useFilteredQuery(agentActivitySummary());

    const usage = agentUsage();
    const usageResult = useFilteredQuery({ connection: usage.connection, query: usage.query });

    const activityRow = useMemo(
        () => (activity.data?.status === "success" ? toSummaryRow(activity.data.table) : undefined),
        [activity.data],
    );
    const usageTable = useMemo(
        () =>
            usageResult.data?.status === "success"
                ? toDataTable(usageResult.data.table, usage.columnMetadata)
                : undefined,
        [usageResult.data, usage.columnMetadata],
    );
    const usageHeadline = useMemo(() => (usageTable ? AGENT_USAGE_HEADLINE(usageTable) : undefined), [usageTable]);

    return (
        <Section
            id={stageAnchor("agents")}
            title="Agents"
            description="Which agents people actually use, and what each one is for."
        >
            {activity.data?.status === "error" ? (
                <QueryError message={activity.data.error.message} onRetry={activity.refetch} />
            ) : activity.isLoading || !activity.data ? (
                <div className="grid gap-300 md:grid-cols-2">
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : (
                <div className="grid gap-300 md:grid-cols-2">
                    <KpiCard
                        label="Agent users"
                        value={readNumber(activityRow, "[Agent Users]")}
                        emphasis
                        detail={
                            <KpiStat
                                label="Share of active users"
                                value={readNumber(activityRow, "[Agent User Share]")}
                                format="percent"
                            />
                        }
                    />
                    <KpiCard
                        label="Agent sessions"
                        value={readNumber(activityRow, "[Agent Sessions]")}
                        detail={
                            <div className="flex flex-col gap-100">
                                <KpiStat
                                    label="Per agent user"
                                    value={readNumber(activityRow, "[Sessions Per User]")}
                                    format="rate"
                                />
                                <KpiStat
                                    label="Came back for another"
                                    value={readNumber(activityRow, "[Return Rate]")}
                                    format="percent"
                                />
                            </div>
                        }
                    />
                </div>
            )}

            {registry && (
                <OpenDestinationLink destination="governance" stage="estate-health">
                    Where every registered agent sits, who owns it and who can reach it
                </OpenDestinationLink>
            )}

            <div style={{ height: 420 + (usageHeadline ? HEADLINE_SPACE : 0) }}>
                {usageResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={usageResult.data.error.message}
                        onRetry={usageResult.refetch}
                    />
                ) : usageResult.isLoading || !usageTable ? (
                    <QueryLoading className="h-full" />
                ) : usageTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No agent sessions"
                        description="The audit log records no agent use in this period."
                    />
                ) : (
                    <Headlined text={usageHeadline}>
                        <VegaVisual
                            spec={usage.vegaLiteSpec}
                            data={usageTable}
                            theme={theme}
                            header={{
                                title: "Most-used agents",
                                subtitle: "Sessions per agent, as the audit log names them",
                            }}
                        />
                    </Headlined>
                )}
            </div>

            <AgentLeaderboard registry={registry} />
        </Section>
    );
}
