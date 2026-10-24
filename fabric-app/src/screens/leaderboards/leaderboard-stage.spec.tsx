//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { ThemeContext } from "@/hooks/theme.context";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { leaderboardConcentration, leaderboardPeople, leaderboardSummary } from "@/queries/work";
import { LeaderboardStage } from "./leaderboard-stage";

const asked = vi.hoisted(() => [] as string[]);

vi.mock("@/hooks/use-filtered-query", async () => {
    const { leaderboardConcentration: concentration, leaderboardSummary: summary } = await import("@/queries/work");
    return {
        useFilteredQuery: ({ query }: { query: string }) => {
            asked.push(query);
            const table =
                query === summary("all").query
                    ? { columns: [{ name: "[All Users]" }, { name: "[All Sessions]" }], rows: [[15447, 5906850]] }
                    : query === concentration("all").query
                      ? {
                            columns: ["[Count]", "[Cumulative]", "[People]", "[Total]"].map((name) => ({ name })),
                            rows: [
                                [155, 1181370, 15447, 5906850],
                                [773, 2953425, 15447, 5906850],
                                [3862, 4725480, 15447, 5906850],
                            ],
                        }
                      : { columns: [], rows: [] };
            return { data: { status: "success", table }, isLoading: false, refetch: () => undefined };
        },
    };
});

function renderStage() {
    render(
        <StageFilterContext.Provider value={pageStages("leaderboard")}>
            <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
                <LeaderboardStage />
            </ThemeContext.Provider>
        </StageFilterContext.Provider>,
    );
}

describe("LeaderboardStage on a live page", () => {
    it("loads the cards first and the ranking only when asked", () => {
        renderStage();
        const ranking = leaderboardPeople("all", describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)).query;

        expect(asked).toContain(leaderboardSummary("all").query);
        expect(asked).not.toContain(leaderboardSummary("licensed").query);
        expect(asked).not.toContain(ranking);
        expect(screen.queryByText("Agent with most users")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Show the ranking" }));
        expect(asked).toContain(ranking);
    });

    it("shows the busiest 1%, 5% and 25% from their three cuts, without a curve", () => {
        renderStage();
        const callouts = leaderboardConcentration("all", describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)).query;

        expect(asked).toContain(callouts);
        expect(callouts).not.toContain("GENERATESERIES");
        const card = screen.getByRole("article", { name: "How concentrated sessions are" });
        expect(within(card).getAllByRole("term").map((term) => term.textContent)).toEqual([
            "Top 1% of people",
            "Top 5% of people",
            "Top 25% of people",
        ]);
        expect(screen.getByText("The top 5% of people account for 50% of sessions.")).toBeTruthy();
    });
});
