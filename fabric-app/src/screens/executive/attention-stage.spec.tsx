//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { NavigationContext } from "@/hooks/navigation.context";
import { DEPARTMENT_ADVICE } from "@/lib/department-coverage";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import type { SummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { agentEstateSummary } from "@/queries/agents";
import registryRows from "@/queries/agents/__fixtures__/agent-estate-summary.rows.json";
import { executiveDepartments } from "@/queries/executive";
import departmentRows from "@/queries/executive/__fixtures__/executive-departments.rows.json";
import summaryRows from "@/queries/executive/__fixtures__/executive-summary.rows.json";
import { feedbackCategory } from "@/queries/feedback";
import themeRows from "@/queries/feedback/__fixtures__/feedback-category.rows.json";
import { licenseDormancy, licenseEstateSummary } from "@/queries/licensing";
import dormancyRows from "@/queries/licensing/__fixtures__/license-dormancy.rows.json";
import estateRows from "@/queries/licensing/__fixtures__/license-estate-summary.rows.json";
import { AttentionStage } from "./attention-stage";
import type { ExecutiveData } from "./use-executive-data";

function toTable(rows: readonly Record<string, unknown>[]) {
    const names = Object.keys(rows[0] ?? {});
    return { columns: names.map((name) => ({ name })), rows: rows.map((row) => names.map((name) => row[name])) };
}

// An install with ValueLens alone: every page but the Consumption ones, and no Cowork rule.
vi.mock("@/lib/runtime-config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({
        rayfin: {},
        semanticModels: { vl: { workspaceId: "11111111-1111-1111-1111-111111111111", itemId: "22222222-2222-2222-2222-222222222222" } },
    }),
}));

vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: (config: { query: string }) => {
        const answers = new Map<string, readonly Record<string, unknown>[]>([
            [licenseDormancy().query, dormancyRows],
            [licenseEstateSummary().query, estateRows],
            [feedbackCategory().query, themeRows],
            [agentEstateSummary().query, registryRows],
        ]);
        const rows = answers.get(config.query);
        return {
            data: rows && { status: "success", table: toTable(rows) },
            isLoading: false,
            isRefreshing: false,
            refetch: () => undefined,
        };
    },
}));

const refetch = () => undefined;
const data = {
    summary: { row: summaryRows[0] as SummaryRow, loaded: true, error: undefined, refetch },
    departments: {
        table: toDataTable(toTable(departmentRows) as never, executiveDepartments().columnMetadata),
        isLoading: false,
        error: undefined,
        refetch,
    },
} as unknown as ExecutiveData;

function renderStage(shell?: ReactNode) {
    const navigate = vi.fn();
    render(
        shell === undefined ? (
            <NavigationContext.Provider value={{ navigate }}>
                <AttentionStage data={data} />
            </NavigationContext.Provider>
        ) : (
            <AttentionStage data={data} />
        ),
    );
    return navigate;
}

const items = () => within(screen.getByRole("list")).getAllByRole("listitem");
const trust = () => screen.getByRole("article", { name: "Can we trust these numbers?" });

/**
 * The stage with the summary's `[People With Organization]` at `have`, grouped
 * by `column`. That measure counts everyone with a task once any org data is
 * loaded, so nothing should be read from it.
 */
function renderWithOrgCount(have: number, column = DEFAULT_ORG_ATTRIBUTE) {
    const row = { ...summaryRows[0], "[People With Organization]": have } as SummaryRow;
    const filters = {
        filters: defaultFilters,
        setFilters: () => undefined,
        options: undefined,
        optionsError: undefined,
        applicable: [],
        orgAttribute: describeOrgAttribute(column),
        orgAttributes: [DEFAULT_ORG_ATTRIBUTE, column],
        orgValues: undefined,
    };
    render(
        <FilterContext.Provider value={filters}>
            <NavigationContext.Provider value={{ navigate: vi.fn() }}>
                <AttentionStage data={{ ...data, summary: { ...data.summary, row } } as ExecutiveData} />
            </NavigationContext.Provider>
        </FilterContext.Provider>,
    );
}

describe("What needs attention", () => {
    it("lists the decisions, the most people or ratings first, each saying whether it's a problem or an opportunity", () => {
        renderStage();
        expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
            "Opportunity: Teams & Remote Work is the least liked theme",
            "Opportunity: Focus enablement on HR and Finance",
            "Opportunity: Reassign 49 idle seats",
        ]);
        expect(within(items()[2]).getByText("22% of seats")).toBeTruthy();
    });

    it("opens the page behind each decision at the right stage", () => {
        const navigate = renderStage();
        fireEvent.click(within(items()[2]).getByRole("button", { name: /Open Readiness/ }));
        expect(navigate).toHaveBeenCalledWith("readiness", "license-readiness");
    });

    it("leaves the links out when there's no app shell to open them in", () => {
        renderStage(null);
        expect(items()).toHaveLength(3);
        expect(screen.queryByRole("button", { name: /Open / })).toBeNull();
    });

    it("says what the figures rest on", () => {
        renderStage();
        expect(screen.getByText("Reconciles with activity")).toBeTruthy();
        expect(within(trust()).getByText("People with an organization").nextElementSibling?.textContent).toBe(DEPARTMENT_ADVICE);
        expect(
            screen.getByText(
                "None of the 4,500 agent sessions match an agent it lists, so agents go by the names the audit log gives them. Updated 15 Sept 2026.",
            ),
        ).toBeTruthy();
    });

    it.each([180, 45])("says how to fill in departments without counting who has one, whatever the summary counts (%i)", (have) => {
        renderWithOrgCount(have);
        expect(within(trust()).getByText("People with an organization").nextElementSibling?.textContent).toBe(DEPARTMENT_ADVICE);
        expect(trust().textContent).not.toMatch(/have a department|people with a task|\d+ of [\d,]+ people/);
    });

    it("says nothing about people with another org attribute, which the summary never counted", () => {
        renderWithOrgCount(180, "officeLocation");
        expect(within(trust()).queryByText("People with an office location")).toBeNull();
        expect(trust().textContent).not.toMatch(/people with a task/);
    });
});