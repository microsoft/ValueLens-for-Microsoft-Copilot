//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { coworkByGroup, coworkCreditsSummary } from "@/queries/consumption";
import { CoworkStage } from "./cowork-stage";

const asked = vi.hoisted(() => [] as string[]);

vi.mock("./data", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./data")>();
    const result = (source: { query: string }) => {
        asked.push(source.query);
        return { data: undefined, isLoading: true, refetch: () => undefined, row: undefined, notFilteredBy: [] };
    };
    return { ...actual, useConsumptionSummary: result, useConsumptionTable: result };
});

vi.mock("@/components/report-panels", () => ({
    KpiRowState: () => null,
    ChartPanel: () => null,
    NoteCard: () => null,
    RollupGrid: ({ title }: { title: string }) => <p>{title}</p>,
}));

describe("CoworkStage on a live page", () => {
    it("loads the credit cards first and the group list only when asked", () => {
        render(
            <StageFilterContext.Provider value={pageStages("cowork-credits")}>
                <CoworkStage options={undefined} rates={undefined} />
            </StageFilterContext.Provider>,
        );

        expect(asked).toContain(coworkCreditsSummary().query);
        expect(asked).not.toContain(coworkByGroup().query);
        expect(screen.queryByText("Credits by group")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Show credits by group" }));
        expect(asked).toContain(coworkByGroup().query);
        expect(screen.getByText("Credits by group")).toBeTruthy();
    });
});
