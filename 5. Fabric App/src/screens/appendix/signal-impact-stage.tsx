//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { ExternalLink } from "lucide-react";
import { ChoiceMenu } from "@/components/choice-menu";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { columnHeat, columnValues, heatRenderer, type HeatDomain } from "@/lib/heat";
import { toDataTable } from "@/lib/to-data-table";
import { signalImpact } from "@/queries/appendix";

const MINUTES = "Human Equivalent (Minutes)";

/**
 * Rows wrap, so their height is only known once drawn. A short list sizes the
 * card to roughly fit; a long one caps it and the grid scrolls.
 */
const GRID_CHROME = 150;
const ROW_ESTIMATE = 58;

/** Grid cells do not wrap by default; the long text here has to. */
function Wrap({ children }: { children: ReactNode }) {
    return <span className="block whitespace-normal">{children}</span>;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function safeUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function signalColumns(minutesHeat: HeatDomain | undefined): GridColumnDef[] {
    return [
        {
            id: "AI Tasks",
            header: "AI task",
            width: 200,
            cellRenderer: (value, row: Row) => (
                <span className="flex flex-col gap-100 whitespace-normal">
                    <span className="font-semibold">{text(value)}</span>
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        {text(row["Category"])}
                    </span>
                </span>
            ),
        },
        {
            id: "Signal",
            header: "Signal in the audit log",
            width: 250,
            cellRenderer: (value) => (
                <span className="block text-[length:var(--text-200)] leading-200 whitespace-normal text-muted-foreground">
                    {text(value)}
                </span>
            ),
        },
        { id: "Use Case", header: "Use case", cellRenderer: (value) => <Wrap>{text(value)}</Wrap> },
        { id: "Value Outcome", header: "Value outcome", width: 150, cellRenderer: (value) => <Wrap>{text(value)}</Wrap> },
        {
            id: MINUTES,
            header: "Human minutes",
            width: 120,
            numericStyling: true,
            cellRenderer: heatRenderer({
                domain: minutesHeat,
                format: (value) => (typeof value === "number" ? `${formatKpi(value, "whole")} min` : null),
            }),
        },
        {
            id: "Research Source",
            header: "Research source",
            width: 280,
            cellRenderer: (value, row: Row) => {
                const href = safeUrl(row["Source URL"]);
                const confidence = text(row["Confidence"]);
                return (
                    <span className="flex flex-col gap-100 whitespace-normal">
                        {href ? (
                            <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-baseline gap-100 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            >
                                <span>{text(value) || href}</span>
                                <ExternalLink className="icon-size-100 shrink-0 translate-y-[1px]" aria-hidden="true" />
                                <span className="sr-only">(opens in a new tab)</span>
                            </a>
                        ) : (
                            <span>{text(value)}</span>
                        )}
                        {confidence && (
                            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                {confidence} confidence
                            </span>
                        )}
                    </span>
                );
            },
        },
        { id: "Source URL", header: "Source URL", hidden: true },
        { id: "Confidence", header: "Confidence", hidden: true },
        { id: "Category", header: "Category", hidden: true },
    ];
}

function withCategory(table: DataTable, category: string | undefined): DataTable {
    if (!category) return table;
    const index = table.columns.findIndex((column) => column.name === "Category");
    return index < 0 ? table : { ...table, rows: table.rows.filter((row) => row[index] === category) };
}

/**
 * The report's Signal → Impact appendix: the audit-log signal ValueLens reads
 * as an AI task, the human time that task would take, and the research the
 * estimate rests on. These are the editable assumptions behind the Value
 * destination, so the minutes are shaded on one scale for every category.
 */
export function SignalImpactStage() {
    const { theme } = useThemeContext();
    const config = signalImpact();
    const result = useFilteredQuery({ connection: config.connection, query: config.query });
    const [category, setCategory] = useState<string>();

    const table = useMemo(
        () => (result.data?.status === "success" ? toDataTable(result.data.table, config.columnMetadata) : undefined),
        [result.data, config.columnMetadata],
    );
    const categories = useMemo(() => {
        const counts = new Map<string, number>();
        for (const value of columnValues(table, "Category")) {
            if (typeof value === "string" && value) counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, count]) => ({ value, label: value, count }));
    }, [table]);
    const selected = category && categories.some((choice) => choice.value === category) ? category : undefined;
    const visible = useMemo(() => (table ? withCategory(table, selected) : undefined), [table, selected]);
    const columns = useMemo(() => signalColumns(columnHeat(table, MINUTES)), [table]);

    return (
        <Section
            id={stageAnchor("signal-impact")}
            title="Signal → Impact"
            description="What the audit log shows, the AI task ValueLens reads it as, and the human time that task would otherwise take. These are the assumptions behind every value estimate."
            actions={
                categories.length > 1 ? (
                    <ChoiceMenu
                        label="Category"
                        allLabel="All categories"
                        choices={categories}
                        value={selected}
                        onChange={setCategory}
                    />
                ) : undefined
            }
        >
            <p className="max-w-[85ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                The minutes live in the semantic model's Human Time Estimates table, so an organisation can replace
                them with its own timings; the Value destination uses whatever that table holds. Each estimate links
                to the research it loosely draws on, with the model's confidence in it.
            </p>

            <div
                className="flex h-[720px] flex-col"
                style={visible ? { height: Math.min(720, GRID_CHROME + visible.rows.length * ROW_ESTIMATE) } : undefined}
            >
                {result.data?.status === "error" ? (
                    <QueryError className="h-full" message={result.data.error.message} onRetry={result.refetch} />
                ) : result.isLoading || !visible ? (
                    <QueryLoading className="h-full" />
                ) : visible.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No signals mapped"
                        description="The semantic model's Behavior Value Map table is empty. It ships with the ValueLens template, so check that the model was deployed from it."
                    />
                ) : (
                    <DataGrid
                        key={selected ?? "all"}
                        columns={columns}
                        data={visible}
                        theme={theme}
                        header={{
                            title: selected ? `${selected} signals` : "Every signal ValueLens values",
                            subtitle: `${formatKpi(visible.rows.length, "whole")} signals · minutes shaded on one scale across all categories`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
