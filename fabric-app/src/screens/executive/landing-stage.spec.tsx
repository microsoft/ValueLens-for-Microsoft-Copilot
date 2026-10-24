//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { FilterContext } from "@/hooks/filter.context";
import { ThemeContext } from "@/hooks/theme.context";
import { DEPARTMENT_ADVICE } from "@/lib/department-coverage";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import type { SummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { executiveDepartments } from "@/queries/executive";
import departmentRows from "@/queries/executive/__fixtures__/executive-departments.rows.json";
import summaryRows from "@/queries/executive/__fixtures__/executive-summary.rows.json";
import { LandingStage } from "./landing-stage";
import type { ExecutiveData } from "./use-executive-data";

// jsdom has no layout, and the charts and grids size themselves to their container.
vi.stubGlobal(
    "ResizeObserver",
    class {
        observe() {}
        unobserve() {}
        disconnect() {}
    },
);

// The kinds of work aren't under test here.
vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: () => ({
        data: { status: "success", table: { columns: [], rows: [] } },
        isLoading: false,
        isRefreshing: false,
        refetch: () => undefined,
    }),
}));

const COLUMNS = Object.keys(departmentRows[0]);
const refetch = () => undefined;

/**
 * The stage with `departments` and the summary's `[People With Organization]`
 * at `have`, grouped by `column`. That measure counts everyone with a task once
 * any org data is loaded, so nothing should be read from it.
 */
function renderStage(departments: readonly Record<string, unknown>[], have: number, column = DEFAULT_ORG_ATTRIBUTE): string {
    const table = { columns: COLUMNS.map((name) => ({ name })), rows: departments.map((row) => COLUMNS.map((name) => row[name])) };
    const data = {
        summary: { row: { ...summaryRows[0], "[People With Organization]": have } as SummaryRow, loaded: true, error: undefined, refetch },
        departments: {
            table: toDataTable(table as never, executiveDepartments().columnMetadata),
            isLoading: false,
            error: undefined,
            refetch,
        },
    } as unknown as ExecutiveData;
    render(
        <FilterContext.Provider
            value={{
                filters: defaultFilters,
                setFilters: () => undefined,
                options: undefined,
                optionsError: undefined,
                applicable: [],
                orgAttribute: describeOrgAttribute(column),
                orgAttributes: [DEFAULT_ORG_ATTRIBUTE, column],
                orgValues: undefined,
            }}
        >
            <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
                <LandingStage data={data} />
            </ThemeContext.Provider>
        </FilterContext.Provider>,
    );
    return document.body.textContent ?? "";
}

const NO_COUNT = /have a department|people with a task|\d+ of [\d,]+ people/;

describe("Where it is landing", () => {
    it("says where the department comes from when there are no organizations to compare, without counting who has one", () => {
        const text = renderStage([], 180);
        expect(screen.getByText("No organizations to compare")).toBeTruthy();
        expect(
            screen.getByText(
                "Nobody in the current selection has a license or a task with organization recorded. The organization comes from each person's Department in Microsoft Entra ID. If it's blank for most people, fill it in there.",
            ),
        ).toBeTruthy();
        expect(text).not.toMatch(NO_COUNT);
    });

    it.each([180, 45])("keeps the advice under the organizations whatever the summary counts (%i), with no count", (have) => {
        const text = renderStage(departmentRows, have);
        expect(text).toContain(`Shading compares the organizations with each other. ${DEPARTMENT_ADVICE}`);
        expect(text).not.toMatch(NO_COUNT);
    });

    it("leaves the advice out for another org attribute, whose source it doesn't know", () => {
        expect(renderStage(departmentRows, 180, "officeLocation")).not.toContain("Microsoft Entra ID");
    });
});
