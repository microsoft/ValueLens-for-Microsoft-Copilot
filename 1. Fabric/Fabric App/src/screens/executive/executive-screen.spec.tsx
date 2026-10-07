//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { FilterContext } from "@/hooks/filter.context";
import { ThemeContext } from "@/hooks/theme.context";
import { useAppTheme } from "@/hooks/use-theme";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { agentEstateSummary } from "@/queries/agents";
import registryRows from "@/queries/agents/__fixtures__/agent-estate-summary.rows.json";
import { executiveWorkKinds } from "@/queries/executive";
import departmentRows from "@/queries/executive/__fixtures__/executive-departments.rows.json";
import monthRows from "@/queries/executive/__fixtures__/executive-months.rows.json";
import summaryRows from "@/queries/executive/__fixtures__/executive-summary.rows.json";
import workKindRows from "@/queries/executive/__fixtures__/executive-work-kinds.rows.json";
import { feedbackCategory } from "@/queries/feedback";
import themeRows from "@/queries/feedback/__fixtures__/feedback-category.rows.json";
import type { FilterOptions } from "@/queries/filters";
import { licenseDormancy, licenseEstateSummary } from "@/queries/licensing";
import dormancyRows from "@/queries/licensing/__fixtures__/license-dormancy.rows.json";
import estateRows from "@/queries/licensing/__fixtures__/license-estate-summary.rows.json";
import { ExecutiveScreen } from ".";

// jsdom has no layout, and the charts and grids size themselves to their container.
vi.stubGlobal(
    "ResizeObserver",
    class {
        observe() {}
        unobserve() {}
        disconnect() {}
    },
);

type Rows = readonly Record<string, unknown>[];

function toTable(rows: Rows) {
    const names = Object.keys(rows[0] ?? {});
    return { columns: names.map((name) => ({ name })), rows: rows.map((row) => names.map((name) => row[name])) };
}

// An install with ValueLens alone, so the credits and Cowork parts stay out.
vi.mock("@/lib/runtime-config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({ rayfin: {}, semanticModels: { vl: { workspaceId: "workspace", itemId: "model" } } }),
}));

vi.mock("@/components/commercial-terms-provider", () => ({
    CommercialTermsProvider: ({ children }: { children: ReactNode }) => children,
}));

/** Each query the page runs, answered with what the demo tenant's model returned for it. */
function answer(query: string): Rows | undefined {
    const exact = new Map<string, Rows>([
        [licenseDormancy().query, dormancyRows],
        [licenseEstateSummary().query, estateRows],
        [feedbackCategory().query, themeRows],
        [agentEstateSummary().query, registryRows],
        [executiveWorkKinds().query, workKindRows],
    ]);
    if (exact.has(query)) return exact.get(query);
    // The month and department queries are written for the range and org column, so match them by what they return.
    if (query.includes("Hours Conservative")) return summaryRows;
    if (query.includes("Hours Per Seat Month")) return departmentRows;
    if (query.includes('"Month Start"')) return monthRows;
    return undefined;
}

vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: (config: { query: string }) => {
        const rows = answer(config.query);
        return {
            data: rows && { status: "success", table: toTable(rows) },
            isLoading: false,
            isRefreshing: false,
            refetch: () => undefined,
        };
    },
}));

/** Mirrors the theme provider `main.tsx` mounts around the app. */
function Themed({ children }: { children: ReactNode }) {
    const { isDark, toggleTheme } = useAppTheme();
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ isDark, toggleTheme, theme }}>{children}</ThemeContext.Provider>;
}

function renderScreen(dates: Partial<FilterOptions> = { firstDate: "2026-05-08", lastDate: "2026-07-06" }) {
    const options = { agentTypes: [], agentNames: [], activities: [], firstDate: undefined, lastDate: undefined, ...dates };
    render(
        <FilterContext.Provider
            value={{
                filters: defaultFilters,
                setFilters: () => undefined,
                options,
                optionsError: undefined,
                applicable: [],
                orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                orgValues: undefined,
            }}
        >
            <Themed>
                <ExecutiveScreen />
            </Themed>
        </FilterContext.Provider>,
    );
}

describe("Executive summary", () => {
    async function pageText(): Promise<string> {
        await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4));
        return document.body.textContent ?? "";
    }

    it("tells the story in four parts, top to bottom", async () => {
        renderScreen();
        await pageText();
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
            "The bottom line",
            "Is it growing?",
            "Where it is landing",
            "What needs attention",
        ]);
    });

    it("leads with the work done, each figure once", async () => {
        renderScreen();
        const text = await pageText();
        for (const figure of ["1,542", "695 – 2,258", "51 min", "6,300", "15 of 47", "66.7%", "21.7%", "62.2%"]) {
            expect(text.split(figure)).toHaveLength(2);
        }
        expect(screen.getByText("Habit rate · June")).toBeTruthy();
    });

    it("hides the arrows while the range holds fewer than two full months", async () => {
        renderScreen();
        const text = await pageText();
        expect(text).toContain("Arrows comparing one month with the one before appear when the date range covers two full months.");
        expect(text).not.toMatch(/\b[A-Z][a-z]{2} vs [A-Z][a-z]{2}\b/);
    });

    it("ranks the organizations by expert hours per seat", async () => {
        renderScreen();
        await pageText();
        const names = screen
            .getAllByRole("row")
            .map((row) => /^([A-Za-z]+)\d/.exec(row.textContent ?? "")?.[1])
            .filter(Boolean);
        expect(names).toEqual(["Sales", "IT", "Legal", "Marketing", "Finance", "HR"]);
    });

    it("prints no money, and leaves the credit figures out when the Consumption model isn't installed", async () => {
        renderScreen();
        const text = await pageText();
        expect(text).not.toMatch(/[£$€¥]/);
        expect(screen.queryByText("Credits consumed · whole tenant")).toBeNull();
        expect(screen.queryByText("Credits consumed by month")).toBeNull();
        expect(screen.queryByText("Credit data")).toBeNull();
    });

    it("says so when the date range misses every day with activity", async () => {
        renderScreen({ firstDate: undefined, lastDate: undefined });
        expect(await screen.findByText("No Copilot activity in this date range")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "The bottom line" })).toBeNull();
    });
});