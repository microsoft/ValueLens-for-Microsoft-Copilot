//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { NavigationContext } from "@/hooks/navigation.context";
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
    runtimeConfig: () => ({ rayfin: {}, semanticModels: { vl: { workspaceId: "workspace", itemId: "model" } } }),
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

describe("What needs attention", () => {
    it("lists the decisions, the most people or ratings first, each saying whether it's a problem or an opportunity", () => {
        renderStage();
        expect(items().map((item) => within(item).getByRole("heading").textContent)).toEqual([
            "Opportunity: Teams & Remote Work is the least liked theme",
            "Opportunity: Reassign 49 idle seats",
            "Opportunity: Focus enablement on HR",
        ]);
        expect(within(items()[1]).getByText("22% of seats")).toBeTruthy();
    });

    it("opens the page behind each decision at the right stage", () => {
        const navigate = renderStage();
        fireEvent.click(within(items()[1]).getByRole("button", { name: /Open Readiness/ }));
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
        expect(screen.getByText("100% of the 180 people with a task")).toBeTruthy();
        expect(
            screen.getByText(
                "None of the 4,500 agent sessions match an agent it lists, so agents go by the names the audit log gives them. Updated 15 Sept 2026.",
            ),
        ).toBeTruthy();
    });
});