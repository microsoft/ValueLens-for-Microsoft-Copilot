//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    availablePresets,
    defaultFilters,
    filterExpressions,
    formatDateRange,
    isFilterActive,
    presetRange,
    summariseSelection,
    type FilterKey,
    type FilterState,
} from "./filters";

const ALL_KEYS: FilterKey[] = ["dateRange", "organizations", "licence", "audience", "agentTypes", "agentNames"];

describe("filterExpressions", () => {
    it("emits nothing for the default state", () => {
        expect(ALL_KEYS.some((key) => isFilterActive(defaultFilters, key))).toBe(false);
        expect(filterExpressions(defaultFilters, ALL_KEYS)).toEqual([]);
    });

    it("emits one argument per active filter, in key order", () => {
        const state: FilterState = {
            dateRange: { preset: "4w", from: "2026-06-09", to: "2026-07-06" },
            orgAttribute: "Organization",
            organizations: ["HR", "IT"],
            licence: "unlicensed",
            audience: "agents",
            agentTypes: ["Microsoft"],
            agentNames: ["Sales Agent 365"],
        };
        expect(filterExpressions(state, ALL_KEYS)).toEqual([
            "FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= DATE(2026, 6, 9) && 'Calendar'[Date] <= DATE(2026, 7, 6))",
            `TREATAS({"HR", "IT"}, 'Chat + Agent Org Data'[Organization])`,
            `TREATAS({"Unlicensed"}, 'Chat + Agent Interactions (Audit Logs)'[Environment])`,
            `TREATAS({"Agents"}, 'Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)])`,
            `TREATAS({"Microsoft"}, 'Agents 365'[Agent Type Label])`,
            `TREATAS({"Sales Agent 365"}, 'Chat + Agent Interactions (Audit Logs)'[AgentName])`,
        ]);
    });

    it("filters Cowork through the same Activity column the report uses", () => {
        const state: FilterState = { ...defaultFilters, audience: "cowork" };
        expect(filterExpressions(state, ["audience"])).toEqual([
            `TREATAS({"Cowork"}, 'Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)])`,
        ]);
    });

    it("filters the org column chosen in Group by", () => {
        const state: FilterState = { ...defaultFilters, orgAttribute: "officeLocation", organizations: ["Dublin"] };
        expect(filterExpressions(state, ["organizations"])).toEqual([
            `TREATAS({"Dublin"}, 'Chat + Agent Org Data'[officeLocation])`,
        ]);
    });

    it("skips active filters that the destination does not respond to", () => {
        const state: FilterState = { ...defaultFilters, licence: "licensed", organizations: ["Sales"] };
        expect(filterExpressions(state, ["dateRange", "licence"])).toEqual([
            `TREATAS({"Licensed"}, 'Chat + Agent Interactions (Audit Logs)'[Environment])`,
        ]);
    });
});

describe("date presets", () => {
    it("offers only presets shorter than the data window", () => {
        // 60 days of data: 4 and 8 weeks fit, 12 weeks would select everything.
        expect(availablePresets("2026-05-08", "2026-07-06")).toEqual(["4w", "8w"]);
        expect(availablePresets("2026-07-01", "2026-07-06")).toEqual([]);
    });

    it("anchors a preset on the last date with data", () => {
        expect(presetRange("4w", "2026-05-08", "2026-07-06")).toEqual({
            preset: "4w",
            from: "2026-06-09",
            to: "2026-07-06",
        });
    });

    it("clamps a preset to the first date with data", () => {
        expect(presetRange("12w", "2026-05-08", "2026-07-06").from).toBe("2026-05-08");
    });
});

describe("labels", () => {
    it("formats a range compactly within a year", () => {
        expect(formatDateRange("2026-05-08", "2026-07-06")).toBe("8 May – 6 Jul 2026");
        expect(formatDateRange("2025-12-29", "2026-01-04")).toBe("29 Dec 2025 – 4 Jan 2026");
    });

    it("summarises a multi-select", () => {
        expect(summariseSelection([], "All organizations", "organizations")).toBe("All organizations");
        expect(summariseSelection(["HR"], "All organizations", "organizations")).toBe("HR");
        expect(summariseSelection(["HR", "IT"], "All organizations", "organizations")).toBe("2 organizations");
    });
});
