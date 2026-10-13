//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SourceState } from "@/lib/optional-sources";
import type { SummaryRow } from "@/lib/summary-row";
import {
    AGENT_INVENTORY_FORBIDDEN,
    describeResourceGraph,
    FOUNDRY_FORBIDDEN,
    RESOURCE_GRAPH_NO_DATA,
    RESOURCE_GRAPH_NOT_SET_UP,
} from "@/queries/governance";
import { ResourceGraphPanel } from "./resource-graph-panel";

function summaryOf(result: { row?: SummaryRow; loaded: boolean; error?: string }, source: SourceState = "present") {
    const full = { row: result.row, loaded: result.loaded, error: result.error, refetch: vi.fn() };
    return { result: full, view: describeResourceGraph(full, source) };
}

const READY = {
    "[Configured Agents]": 12,
    "[Matched Agents]": 9,
    "[No Sign In]": 2,
    "[No Sign In Configured]": 3,
    "[Web Search]": 4,
    "[Foundry Resources]": 5,
    "[Foundry Public]": 3,
    "[Foundry Public Projects]": 1,
    "[Agent Status]": "ok",
    "[Foundry Status]": "ok",
};

describe("ResourceGraphPanel", () => {
    it("asks for the installer when Resource Graph is off", () => {
        render(<ResourceGraphPanel summary={summaryOf({ loaded: false }, "notConfigured")} />);
        expect(screen.getByText(RESOURCE_GRAPH_NOT_SET_UP.title)).toBeTruthy();
        expect(screen.getByText(/Turn on Azure Resource Graph in the installer/)).toBeTruthy();
    });

    it("reads a model without the tables as not set up rather than as a fault", () => {
        const error = "Query (3, 5) Cannot find table 'Agent Configuration'.";
        render(<ResourceGraphPanel summary={summaryOf({ loaded: false, error }, "unknown")} />);
        expect(screen.getByText(RESOURCE_GRAPH_NOT_SET_UP.title)).toBeTruthy();
    });

    it("says nothing has loaded yet, with the missing roles", () => {
        const row = { ...READY, "[Configured Agents]": 0, "[Foundry Resources]": 0, "[Agent Status]": "forbidden", "[Foundry Status]": "forbidden" };
        render(<ResourceGraphPanel summary={summaryOf({ row, loaded: true })} />);
        expect(screen.getByText(RESOURCE_GRAPH_NO_DATA.title)).toBeTruthy();
        expect(screen.getByText(AGENT_INVENTORY_FORBIDDEN)).toBeTruthy();
        expect(screen.getByText(FOUNDRY_FORBIDDEN)).toBeTruthy();
    });

    it("shows the counts, and marks a side it couldn't read", () => {
        const row = { ...READY, "[Foundry Resources]": 0, "[Foundry Public]": 0, "[Foundry Status]": "forbidden" };
        const summary = summaryOf({ row, loaded: true });
        render(<ResourceGraphPanel summary={summary} />);
        expect(screen.getByText("No sign-in required")).toBeTruthy();
        expect(screen.getByText("Web search on")).toBeTruthy();
        expect(screen.getByText("Foundry open to the public network")).toBeTruthy();
        expect(screen.getAllByText("Not read").length).toBeGreaterThan(0);
        expect(screen.getByText(FOUNDRY_FORBIDDEN)).toBeTruthy();
        expect(screen.queryByText(AGENT_INVENTORY_FORBIDDEN)).toBeNull();
    });
});
