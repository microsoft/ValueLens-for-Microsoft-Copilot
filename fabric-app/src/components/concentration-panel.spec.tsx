//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { TableResult } from "@/hooks/use-table-query";
import { readConcentrationSlices } from "@/lib/concentration";
import { formatKpi } from "@/lib/format-kpi";
import { ConcentrationCallouts } from "./concentration-panel";

const TITLE = "How concentrated sessions are";

/** Leaderboards' cut rows for 15,447 people: the busiest 155, 773 and 3,862 of them. */
function cuts(rows: unknown[][]): DataTable {
    return {
        columns: ["Count", "Cumulative", "People", "Total"].map((name) => ({ name, displayName: name })),
        rows,
    } as unknown as DataTable;
}

const TOP_THREE = cuts([
    [155, 1181370, 15447, 5906850],
    [773, 2953425, 15447, 5906850],
    [3862, 4725480, 15447, 5906850],
]);

function Callouts({ table, ...state }: { table: DataTable | undefined } & Partial<TableResult>) {
    return (
        <ConcentrationCallouts
            result={{ table, error: undefined, isLoading: false, refetch: () => undefined, ...state }}
            summary={readConcentrationSlices(table)}
            noun="sessions"
            title={TITLE}
            subtitle="The share of sessions taken by the busiest 1%, 5% and 25% of people"
            emptyTitle="Nobody to rank"
            emptyDescription="No one had sessions in this selection."
        />
    );
}

describe("ConcentrationCallouts", () => {
    it("shows the top 1%, 5% and 25% as one card, without a curve", () => {
        const { container } = render(<Callouts table={TOP_THREE} />);
        const card = screen.getByRole("article", { name: TITLE });
        const figures = within(card)
            .getAllByRole("term")
            .map((term) => [term.textContent, ...[...term.parentElement!.querySelectorAll("dd")].map((dd) => dd.textContent)]);
        expect(figures).toEqual([
            ["Top 1% of people", "20%", `${formatKpi(155, "whole")} people`],
            ["Top 5% of people", "50%", `${formatKpi(773, "whole")} people`],
            ["Top 25% of people", "80%", `${formatKpi(3862, "whole")} people`],
        ]);
        expect(container.querySelector("canvas, svg")).toBeNull();
    });

    it("exports as one slide, titled by its headline", () => {
        render(<Callouts table={TOP_THREE} />);
        const headline = screen.getByText("The top 5% of people account for 50% of sessions.");
        expect(headline.hasAttribute("data-headline")).toBe(true);
        const slide = headline.closest("[data-export]")!;
        expect(slide.parentElement?.closest("[data-export]")).toBeNull();
        expect(within(slide as HTMLElement).getByRole("article", { name: TITLE }).getAttribute("data-export-title")).toBe(TITLE);
    });

    it("shows a dash for a slice of fewer than five people", () => {
        // 20 people: the top 1% and 5% are one person each, and the top 25% is five.
        render(<Callouts table={cuts([[1, 40, 20, 100], [5, 70, 20, 100]])} />);
        expect(screen.getAllByText("—")).toHaveLength(2);
        expect(screen.getAllByText("Under 5 people")).toHaveLength(2);
        expect(screen.getByText("The top 25% of people account for 70% of sessions.")).toBeTruthy();
    });

    it("waits for its query, then shows nobody to rank when no one had a value", () => {
        const { rerender } = render(<Callouts table={undefined} isLoading />);
        expect(screen.getByRole("status").textContent).toContain("Loading");
        rerender(<Callouts table={cuts([])} />);
        expect(screen.getByText("Nobody to rank")).toBeTruthy();
        expect(screen.queryByRole("article")).toBeNull();
    });

    it("fails with a retry rather than show partial figures", () => {
        const refetch = vi.fn();
        render(<Callouts table={cuts([[155, 1181370, 15447, 5906850], [773, 2953425, 15447, 5906850]])} refetch={refetch} />);
        expect(screen.getByRole("alert").textContent).toContain("The concentration totals are incomplete.");
        expect(screen.queryByRole("article")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(refetch).toHaveBeenCalledOnce();
    });

    it("shows the query's own error", () => {
        render(<Callouts table={undefined} error="The query timed out." />);
        expect(screen.getByRole("alert").textContent).toContain("The query timed out.");
    });
});
