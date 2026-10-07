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
    selectedCohort,
    summariseSelection,
    unlicensedOnly,
    unshownActivity,
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

describe("selectedCohort", () => {
    const BOTH: FilterKey[] = ["licence", "audience"];
    const WORK = ["licensed", "unlicensed", "agents", "cowork"] as const;
    const ACTIVATION = ["licensed", "unlicensed", "agents"] as const;
    const pick = (licence: FilterState["licence"], audience: FilterState["audience"]) => ({
        ...defaultFilters,
        licence,
        audience,
    });

    it("is all when neither filter picks a group", () => {
        expect(selectedCohort(defaultFilters, BOTH, WORK)).toBe("all");
    });

    it("follows License", () => {
        expect(selectedCohort(pick("licensed", "all"), BOTH, WORK)).toBe("licensed");
        expect(selectedCohort(pick("unlicensed", "all"), BOTH, WORK)).toBe("unlicensed");
    });

    it("prefers Activity over License", () => {
        expect(selectedCohort(pick("unlicensed", "agents"), BOTH, WORK)).toBe("agents");
        expect(selectedCohort(pick("licensed", "cowork"), BOTH, WORK)).toBe("cowork");
    });

    it("falls back to License when Activity names no group the stage shows", () => {
        expect(selectedCohort(pick("unlicensed", "copilot"), BOTH, WORK)).toBe("unlicensed");
        expect(selectedCohort(pick("licensed", "cowork"), BOTH, ACTIVATION)).toBe("licensed");
        expect(selectedCohort(pick("all", "cowork"), BOTH, ACTIVATION)).toBe("all");
        expect(selectedCohort(pick("all", "copilot"), BOTH, WORK)).toBe("all");
    });

    it("ignores a filter the destination doesn't offer", () => {
        expect(selectedCohort(pick("licensed", "agents"), ["licence"], WORK)).toBe("licensed");
        expect(selectedCohort(pick("licensed", "all"), ["audience"], WORK)).toBe("all");
        expect(selectedCohort(pick("unlicensed", "agents"), [], WORK)).toBe("all");
    });
});

describe("unshownActivity", () => {
    const BOTH: FilterKey[] = ["licence", "audience"];
    const SHOWN = ["licensed", "unlicensed", "agents"] as const;
    const activity = (audience: FilterState["audience"]) => ({ ...defaultFilters, audience });

    it("names an Activity the stage has no card for", () => {
        expect(unshownActivity(activity("copilot"), BOTH, SHOWN)).toBe("Copilot chat");
        expect(unshownActivity(activity("cowork"), BOTH, SHOWN)).toBe("Cowork");
    });

    it("is undefined when Activity is All, has a card, or isn't offered", () => {
        expect(unshownActivity(defaultFilters, BOTH, SHOWN)).toBeUndefined();
        expect(unshownActivity(activity("agents"), BOTH, SHOWN)).toBeUndefined();
        expect(unshownActivity(activity("cowork"), BOTH, [...SHOWN, "cowork"])).toBeUndefined();
        expect(unshownActivity(activity("copilot"), ["licence"], SHOWN)).toBeUndefined();
    });
});

describe("unlicensedOnly", () => {
    const licence = (value: FilterState["licence"]) => ({ ...defaultFilters, licence: value });

    it("is true only when License picks unlicensed people on a stage that offers it", () => {
        expect(unlicensedOnly(licence("unlicensed"), ["licence"])).toBe(true);
        expect(unlicensedOnly(licence("licensed"), ["licence"])).toBe(false);
        expect(unlicensedOnly(licence("all"), ["licence"])).toBe(false);
        expect(unlicensedOnly(licence("unlicensed"), ["audience"])).toBe(false);
    });
});