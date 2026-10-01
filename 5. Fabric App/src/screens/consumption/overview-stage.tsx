//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { availablePresets, DATE_PRESET_LABELS, formatDateRange, presetRange, type DatePreset } from "@/lib/filters";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { readText, type SummaryRow } from "@/lib/summary-row";
import { formatCell } from "@/lib/tree-grid";
import {
    consumptionByProduct,
    consumptionDates,
    consumptionNotes,
    currencyPrefix,
    isFullCoverage,
    isoDate,
    reportingDateFilter,
    splitCoverage,
} from "@/queries/consumption";
import { CREDIT_CURRENCY, moneyCell, SMALL, useConsumptionSummary, useConsumptionTable, type TableResult } from "./data";
import { ChartPanel, NoteCard, Panel } from "./shared";

type OverviewPreset = Exclude<DatePreset, "custom">;

const AZURE_PRODUCT = /azure|foundry/i;

interface ProductFigures {
    credits: number | undefined;
    cost: number | undefined;
    basis: string | undefined;
}

function numberAt(row: readonly unknown[], index: number): number | undefined {
    const value = index < 0 ? undefined : row[index];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Each product's row of the aligned totals, by product name. */
function productFigures(table: DataTable | undefined): Map<string, ProductFigures> {
    const figures = new Map<string, ProductFigures>();
    if (!table) return figures;
    const column = (name: string) => table.columns.findIndex((candidate) => candidate.name === name);
    const [product, credits, cost, basis] = ["Product", "Credits", "Cost", "Cost Basis"].map(column);
    for (const row of table.rows) {
        const text = row[basis];
        figures.set(String(row[product]), {
            credits: numberAt(row, credits),
            cost: numberAt(row, cost),
            basis: typeof text === "string" ? text : undefined,
        });
    }
    return figures;
}

/** Splits the model's coverage text into a status column and the dates the source holds. */
function withCoverage(table: DataTable): DataTable {
    const index = table.columns.findIndex((column) => column.name === "Coverage");
    if (index < 0) return table;
    return {
        columns: [
            ...table.columns,
            { name: "Coverage Status", displayName: "Coverage" },
            { name: "Source Dates", displayName: "Source holds" },
        ],
        rows: table.rows.map((row) => {
            const coverage = splitCoverage(row[index]);
            return [...row, coverage?.status ?? null, coverage?.source?.replace(" to ", " – ") ?? null];
        }),
    };
}

function coverageCell(value: unknown) {
    const status = typeof value === "string" ? value : undefined;
    if (!status) return null;
    const full = isFullCoverage({ status, source: undefined });
    return <span className={full ? "text-foreground" : "text-muted-foreground"}>{status}</span>;
}

function productTableHeight(result: TableResult): number {
    return gridHeight(result.table?.rows.length ?? 3);
}

/**
 * The report's Combined page: every product's credits and cost over the same
 * dates, side by side, with the basis each cost is worked out on and how much
 * of the window its source actually covers.
 */
export function OverviewStage() {
    const { theme } = useThemeContext();
    const [preset, setPreset] = useState<OverviewPreset>("all");

    const dates = useConsumptionSummary(consumptionDates());
    const first = isoDate(dates.row?.["[First Date]"]);
    const last = isoDate(dates.row?.["[Last Date]"]);
    const presets = useMemo(() => (first && last ? availablePresets(first, last) : []), [first, last]);
    const range = preset !== "all" && first && last ? presetRange(preset, first, last) : undefined;
    const extra = useMemo(() => {
        const span = preset !== "all" && first && last ? presetRange(preset, first, last) : undefined;
        return span ? [reportingDateFilter(span.from, span.to)] : [];
    }, [preset, first, last]);

    const notes = useConsumptionSummary(consumptionNotes(), extra);
    const byProductSource = consumptionByProduct();
    const byProduct = useConsumptionTable(byProductSource, extra);
    const productTable = useMemo(() => (byProduct.table ? withCoverage(byProduct.table) : undefined), [byProduct.table]);
    const figures = useMemo(() => productFigures(byProduct.table), [byProduct.table]);

    const azureCurrency = readText(notes.row, "[Azure Currency]");
    const azurePrefix = currencyPrefix(azureCurrency);
    const presetOptions = useMemo(
        () => [
            { id: "all" as const, label: DATE_PRESET_LABELS.all },
            ...presets.map((id) => ({ id, label: DATE_PRESET_LABELS[id] })),
        ],
        [presets],
    );

    const columns: GridColumnDef[] = useMemo(
        () => [
            { id: "Product", header: "Product", width: 168 },
            { id: "Credits", header: "Credits", width: 112, numericStyling: true, cellRenderer: formatCell("whole") },
            {
                id: "Cost",
                header: "Cost",
                width: 124,
                numericStyling: true,
                cellRenderer: heatRenderer({
                    domain: columnHeat(productTable, "Cost"),
                    format: (value, row) =>
                        moneyCell(AZURE_PRODUCT.test(String(row.Product)) ? azurePrefix : CREDIT_CURRENCY)(value),
                }),
            },
            { id: "Cost Basis", header: "Cost basis", width: 296 },
            { id: "Coverage Status", header: "Coverage", width: 168, cellRenderer: (value) => coverageCell(value) },
            { id: "Source Dates", header: "Source holds", width: 192 },
            { id: "Coverage", header: "Coverage", hidden: true },
            { id: "Product Sort", header: "Order", hidden: true },
        ],
        [productTable, azurePrefix],
    );

    const cowork = [...figures.entries()].find(([name]) => /cowork/i.test(name))?.[1];
    const studio = [...figures.entries()].find(([name]) => /studio/i.test(name))?.[1];
    const azure = [...figures.entries()].find(([name]) => AZURE_PRODUCT.test(name))?.[1];

    return (
        <Section
            id={stageAnchor("consumption-overview")}
            title="All products"
            description="Where credit spend is going: each product's credits and cost over the same dates."
            actions={
                presetOptions.length > 1 ? (
                    <SegmentedControl label="Dates" options={presetOptions} value={preset} onChange={setPreset} />
                ) : undefined
            }
        >
            {range && (
                <p className={`${SMALL} text-muted-foreground`}>
                    Showing {formatDateRange(range.from, range.to)}, the {DATE_PRESET_LABELS[preset].toLowerCase()} with data.
                </p>
            )}

            {byProduct.error === undefined &&
                (byProduct.table === undefined ? (
                    <div className="grid gap-300 md:grid-cols-3">
                        <QueryLoading />
                        <QueryLoading />
                        <QueryLoading />
                    </div>
                ) : (
                    <div className="grid gap-300 md:grid-cols-3">
                        <KpiCard
                            label="Cowork / Work IQ credits"
                            value={cowork?.credits}
                            emphasis
                            detail={<KpiStat label="Cost" value={cowork?.cost} format="money" prefix={CREDIT_CURRENCY} />}
                        />
                        <KpiCard
                            label="Copilot Studio credits"
                            value={studio?.credits}
                            detail={<KpiStat label="Cost" value={studio?.cost} format="money" prefix={CREDIT_CURRENCY} />}
                        />
                        <KpiCard
                            label="Azure AI Foundry cost"
                            value={azure?.cost}
                            format="money"
                            prefix={azurePrefix}
                            detail={azureCurrency ? `Billed in ${azureCurrency}, per token` : "Billed per token"}
                        />
                    </div>
                ))}

            <Panel
                result={byProduct}
                table={productTable}
                height={productTableHeight(byProduct)}
                emptyTitle="No product totals"
                emptyDescription="Consumption Central returned no products for these dates. Check that its model has been refreshed."
            >
                {(table) => (
                    <DataGrid
                        columns={columns}
                        data={table}
                        theme={theme}
                        header={{
                            title: "Aligned source totals",
                            subtitle: "Each cost keeps its own basis, so read them side by side rather than adding them up.",
                        }}
                    />
                )}
            </Panel>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={byProduct}
                    spec={byProductSource.vegaLiteSpec}
                    height={rowChartHeight(byProduct.table?.rows.length ?? 3, { perRow: 48, chrome: 150 })}
                    title="Cost by product"
                    subtitle="The same dates for every product"
                    emptyTitle="No cost to compare"
                    emptyDescription="None of the products has a cost in these dates."
                />
                <OverviewNotes row={notes.row} />
            </div>
        </Section>
    );
}

function OverviewNotes({ row }: { row: SummaryRow | undefined }) {
    return (
        <NoteCard
            title="Reading these figures"
            notes={[
                { term: "Selected dates", text: readText(row, "[Reporting Window]") },
                { term: "Caveat", text: readText(row, "[Reporting Caveat]") },
                { term: "Rates in use", text: readText(row, "[Rates In Use]") },
            ]}
        />
    );
}
