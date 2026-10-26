//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumptionScreen } from "./index";

const { useConsumptionTable, useConsumptionSummary } = vi.hoisted(() => ({
    useConsumptionTable: vi.fn(),
    useConsumptionSummary: vi.fn(),
}));
vi.mock("./data", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./data")>()),
    useConsumptionTable,
    useConsumptionSummary,
}));
vi.mock("@/hooks/stage-filter.context", () => ({
    useStageFilter: () => ({ show: (stage: string) => stage === "consumption-overview", inPack: true }),
}));
vi.mock("@/components/commercial-terms-provider", () => ({
    CommercialTermsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./overview-stage", () => ({ OverviewStage: () => <h2>Consumption overview</h2> }));

afterEach(() => {
    vi.clearAllMocks();
});

describe("ConsumptionScreen when its slicer choices fail", () => {
    it("keeps every stage when Power BI is only busy, with a retry for the choices", () => {
        const refetch = vi.fn();
        useConsumptionTable.mockReturnValue({ table: undefined, error: "Too many requests", isLoading: false, refetch });
        useConsumptionSummary.mockReturnValue({ row: undefined });
        render(<ConsumptionScreen />);

        expect(screen.getByText("Power BI is busy")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Consumption overview" })).toBeTruthy();
        expect(screen.queryByText(/didn't answer/)).toBeNull();
        screen.getByRole("button", { name: "Try again" }).click();
        expect(refetch).toHaveBeenCalledOnce();
    });

    it("still says the model didn't answer when the error is something else", () => {
        useConsumptionTable.mockReturnValue({ table: undefined, error: "Cannot find table 'Credits'.", isLoading: false, refetch: vi.fn() });
        useConsumptionSummary.mockReturnValue({ row: undefined });
        render(<ConsumptionScreen />);

        expect(screen.getByText(/didn't answer/)).toBeTruthy();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
        expect(screen.queryByRole("heading", { name: "Consumption overview" })).toBeNull();
    });
});
