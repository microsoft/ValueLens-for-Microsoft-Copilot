//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { forwardRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DataTable, VisualTheme } from "@microsoft/fabric-visuals-core";
import { ThemeContext } from "@/hooks/theme.context";
import { ChartPanel } from "./report-panels";

const { downloadTableCsv, captureChart, copyOrDownloadImage } = vi.hoisted(() => ({
    downloadTableCsv: vi.fn(),
    captureChart: vi.fn(),
    copyOrDownloadImage: vi.fn(),
}));

vi.mock("@/components/vega-visual", () => ({
    VegaVisual: forwardRef<unknown, { data: DataTable }>(function VegaVisual({ data }) {
        return <div data-testid="vega">{data.rows.length} rows</div>;
    }),
}));
vi.mock("@/lib/table-csv", () => ({ downloadTableCsv }));
vi.mock("@/lib/chart-image", () => ({
    captureChart,
    copyOrDownloadImage,
    backgroundOf: () => "#fff",
    viewToPng: vi.fn(),
}));

const table: DataTable = {
    columns: [{ name: "Month" }, { name: "Users", displayName: "Active users" }],
    rows: [
        ["2026-09-01", 10],
        ["2026-10-01", 12],
    ],
};
const shown: DataTable = { ...table, rows: table.rows.slice(1) };

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(() => {
    vi.clearAllMocks();
});

function renderChart() {
    return render(
        <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
            <ChartPanel
                result={{ table, error: undefined, isLoading: false, refetch: () => {} }}
                table={shown}
                height={300}
                spec={{ mark: "bar" }}
                title="Monthly trend"
                subtitle="Active users by month"
                emptyTitle="No data"
                emptyDescription="Nothing yet"
            />
        </ThemeContext.Provider>,
    );
}

async function choose(label: string) {
    const trigger = screen.getByRole("button", { name: "More actions" });
    await act(async () => {
        fireEvent.keyDown(trigger, { key: "Enter" });
    });
    await act(async () => {
        fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    });
}

describe("ChartPanel actions", () => {
    it("keeps the chart's title and puts its actions in a named toolbar", () => {
        renderChart();
        expect(screen.getByRole("heading", { name: "Monthly trend" })).toBeInTheDocument();
        expect(screen.getByRole("toolbar", { name: "Chart actions for Monthly trend" })).toBeInTheDocument();
        expect(screen.getByTestId("vega")).toHaveTextContent("1 rows");
    });

    it("downloads the rows the chart shows as CSV", async () => {
        renderChart();
        await choose("Download CSV");
        expect(downloadTableCsv).toHaveBeenCalledWith(shown, "Monthly trend");
        expect(screen.getByRole("status")).toHaveTextContent("Downloaded");
    });

    it("copies the chart as a picture, saying so", async () => {
        const png = new Blob(["png"]);
        captureChart.mockResolvedValue(png);
        copyOrDownloadImage.mockResolvedValue("copied");
        renderChart();
        await choose("Copy as image");
        expect(captureChart).toHaveBeenCalledTimes(1);
        expect(copyOrDownloadImage).toHaveBeenCalledWith(png, "Monthly trend", "monthly-trend.png");
        expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });

    it("says the picture was saved when the clipboard turned it down", async () => {
        captureChart.mockResolvedValue(new Blob(["png"]));
        copyOrDownloadImage.mockResolvedValue("downloaded");
        renderChart();
        await choose("Copy as image");
        expect(screen.getByRole("status")).toHaveTextContent("Downloaded");
    });
});
