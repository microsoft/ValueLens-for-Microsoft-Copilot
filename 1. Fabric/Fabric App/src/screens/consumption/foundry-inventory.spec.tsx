//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceAvailabilityContext } from "@/hooks/source-availability.context";
import { ThemeContext } from "@/hooks/theme.context";
import { ALL_UNKNOWN, type SourceState } from "@/lib/optional-sources";

const mocked = vi.hoisted(() => ({
    result: { table: undefined, error: undefined as string | undefined, isLoading: true, refetch: () => {} },
    queries: [] as string[],
}));

vi.mock("./data", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./data")>()),
    useConsumptionTable: (source: { query: string }) => {
        mocked.queries.push(source.query);
        return mocked.result;
    },
}));

import { FOUNDRY_INVENTORY_NOT_SET_UP, uncoveredNote } from "@/queries/consumption";
import { FoundryInventory } from "./foundry-inventory";

function renderWith(resourceGraph: SourceState) {
    return render(
        <SourceAvailabilityContext.Provider value={{ ...ALL_UNKNOWN, resourceGraph }}>
            <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
                <FoundryInventory filters={[]} prefix="$" />
            </ThemeContext.Provider>
        </SourceAvailabilityContext.Provider>,
    );
}

describe("FoundryInventory", () => {
    it("asks for Resource Graph without querying when the install left it off", () => {
        mocked.queries = [];
        renderWith("notConfigured");
        expect(screen.getByText(FOUNDRY_INVENTORY_NOT_SET_UP.title)).toBeTruthy();
        expect(screen.getByText(/Turn on Azure Resource Graph in the installer/)).toBeTruthy();
        expect(mocked.queries.every((query) => query === "")).toBe(true);
    });

    it("reads a model without the inventory table as not set up", () => {
        mocked.result = { ...mocked.result, isLoading: false, error: "Cannot find table 'Foundry Resources'." };
        renderWith("present");
        expect(screen.getByText(FOUNDRY_INVENTORY_NOT_SET_UP.title)).toBeTruthy();
    });

    it("shows any other fault as an error", () => {
        mocked.result = { ...mocked.result, isLoading: false, error: "The query timed out" };
        renderWith("present");
        expect(screen.getByText(/The query timed out/)).toBeTruthy();
    });
});

describe("uncoveredNote", () => {
    it("names a few uncovered subscriptions and stays quiet when all are covered", () => {
        expect(uncoveredNote([], 0)).toBeUndefined();
        expect(uncoveredNote(["sub-a"], 1)).toBe(
            "1 Foundry resource sits in 1 subscription the Azure cost export doesn't cover: sub-a. Add it to the export's scope to see what it costs.",
        );
        expect(uncoveredNote(["a", "b", "c", "d"], 5)).not.toContain(":");
    });
});
