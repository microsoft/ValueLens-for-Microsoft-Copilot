//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { applyDaxFilters } from "@/lib/dax-filters";
import { tenantDefaultDates } from "@/lib/filters";
import { withTaskTimes } from "@/queries/assumptions/task-times";
import { filterOptions } from "@/queries/filters/filter-options";
import { connection } from "@/queries/shared";
import { FilterBar } from "./filter-bar";
import { FilterProvider } from "./filter-provider";

const asked: string[] = [];
let people: number | undefined;

vi.mock("@/hooks/use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query }: { connection: string; query: string }) => {
        asked.push(query);
        if (query !== filterOptions().query || people === undefined) return { data: undefined, isLoading: true };
        const row = (kind: string, value: string) => [kind, value];
        return {
            isLoading: false,
            data: {
                status: "success",
                table: {
                    columns: [{ name: "[Kind]" }, { name: "[Value]" }],
                    rows: [row("firstDate", "2026-01-01"), row("lastDate", "2026-10-04"), row("people", String(people))],
                },
            },
        };
    },
}));

const SUMMARY = 'EVALUATE ROW("People", 1)';

function Summary() {
    useFilteredQuery({ connection, query: SUMMARY });
    return null;
}

function Page() {
    return (
        <FilterProvider applicable={["dateRange", "licence"]}>
            <FilterBar destinationLabel="Adoption" />
            <Summary />
        </FilterProvider>
    );
}

describe("FilterProvider's tenant default dates", () => {
    const filtered = () => applyDaxFilters(withTaskTimes(SUMMARY, []), [tenantDefaultDates()]);
    const summaries = () => new Set(asked.filter((query) => query.includes('ROW("People", 1)')));

    beforeEach(() => {
        asked.length = 0;
        people = undefined;
    });

    it("asks for a page's first query on the default dates before the options answer, and never again once they do", () => {
        const { rerender } = render(<Page />);
        expect([...summaries()]).toEqual([filtered()]);
        expect(screen.getByRole("button", { name: /^Date/ }).textContent).toContain("Default dates");

        people = 20_000;
        rerender(<Page />);
        expect([...summaries()]).toEqual([filtered()]);
        expect(screen.getByRole("button", { name: /^Date/ }).textContent).toContain("Last 12 weeks · 13 Jul – 4 Oct 2026");
    });

    it("keeps the same query on a small tenant, and shows all dates", () => {
        people = 50;
        render(<Page />);
        expect([...summaries()]).toEqual([filtered()]);
        expect(screen.getByRole("button", { name: /^Date/ }).textContent).toContain("All dates");
        expect(screen.queryByText("Default for large organizations")).toBeNull();
    });
});
