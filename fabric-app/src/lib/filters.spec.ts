//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    availablePresets,
    dateFilter,
    defaultFilters,
    differsFromTenantDefault,
    filterExpression,
    filterExpressions,
    formatDateRange,
    isFilterActive,
    isFilterInEffect,
    isLargeTenant,
    isTenantDefaultRange,
    LARGE_TENANT_PEOPLE,
    presetRange,
    shownDateRange,
    TENANT_DEFAULT_RANGE,
    tenantDefaultDates,
    tenantDefaultFilters,
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
describe("the tenant's default dates", () => {
    const LARGE = { firstDate: "2026-01-01", lastDate: "2026-10-04", largeTenant: true };
    const SMALL = { ...LARGE, largeTenant: false };

    it("works out the tenant's size and the last 12 weeks in the query, past every filter", () => {
        const audit = "'Chat + Agent Interactions (Audit Logs)'";
        expect(tenantDefaultDates()).toBe(
            [
                `VAR __TenantLastDate = CALCULATE(MAX(${audit}[ActivityDate]), REMOVEFILTERS())`,
                `VAR __TenantIsLarge = CALCULATE(DISTINCTCOUNTNOBLANK(${audit}[Audit_UserId]), REMOVEFILTERS()) > 10000`,
                "RETURN FILTER(ALL('Calendar'[Date]), NOT __TenantIsLarge || ('Calendar'[Date] > __TenantLastDate - 84 && 'Calendar'[Date] <= __TenantLastDate))",
            ].join("\n    "),
        );
        expect(filterExpression(tenantDefaultFilters, "dateRange")).toBe(tenantDefaultDates());
        expect(dateFilter(TENANT_DEFAULT_RANGE, "'Other'[Day]")).toContain("FILTER(ALL('Other'[Day]), NOT __TenantIsLarge");
        // Every other filter is as it is by default.
        expect(filterExpressions(tenantDefaultFilters, ["organizations", "licence", "audience", "agentTypes", "agentNames"])).toEqual([]);
    });

    it("counts a tenant as large above the threshold", () => {
        expect(LARGE_TENANT_PEOPLE).toBe(10_000);
        expect(isLargeTenant(10_000)).toBe(false);
        expect(isLargeTenant(10_001)).toBe(true);
    });

    it("shows the last 12 weeks to the last day with activity on a large tenant, as the preset does", () => {
        expect(isTenantDefaultRange(tenantDefaultFilters.dateRange)).toBe(true);
        expect(isTenantDefaultRange(presetRange("12w", "2026-01-01", "2026-10-04"))).toBe(false);
        expect(shownDateRange(TENANT_DEFAULT_RANGE, LARGE)).toEqual(presetRange("12w", "2026-01-01", "2026-10-04"));
        expect(shownDateRange(TENANT_DEFAULT_RANGE, LARGE)).toMatchObject({ from: "2026-07-13", to: "2026-10-04" });
    });

    it("shows every date on a small tenant, and while the options load", () => {
        expect(shownDateRange(TENANT_DEFAULT_RANGE, SMALL)).toBeUndefined();
        expect(shownDateRange(TENANT_DEFAULT_RANGE, undefined)).toBeUndefined();
        expect(shownDateRange(TENANT_DEFAULT_RANGE, { ...LARGE, largeTenant: undefined })).toBeUndefined();
        const fixed = { preset: "custom" as const, from: "2026-02-01", to: "2026-02-28" };
        expect(shownDateRange(fixed, SMALL)).toBe(fixed);
    });

    it("is always applied to queries, but in effect only on a large tenant", () => {
        expect(isFilterActive(tenantDefaultFilters, "dateRange")).toBe(true);
        expect(isFilterInEffect(tenantDefaultFilters, "dateRange", LARGE)).toBe(true);
        expect(isFilterInEffect(tenantDefaultFilters, "dateRange", SMALL)).toBe(false);
        expect(isFilterInEffect(tenantDefaultFilters, "dateRange", undefined)).toBe(false);
        expect(isFilterInEffect({ ...defaultFilters, licence: "licensed" }, "licence", SMALL)).toBe(true);
    });

    it("differs from where the tenant starts only when a filter is changed", () => {
        expect(differsFromTenantDefault(tenantDefaultFilters, "dateRange", LARGE)).toBe(false);
        expect(differsFromTenantDefault(defaultFilters, "dateRange", LARGE)).toBe(true);
        // On a small tenant every date is the default too.
        expect(differsFromTenantDefault(defaultFilters, "dateRange", SMALL)).toBe(false);
        expect(differsFromTenantDefault(defaultFilters, "dateRange", undefined)).toBe(true);
        expect(differsFromTenantDefault({ ...tenantDefaultFilters, licence: "licensed" }, "licence", SMALL)).toBe(true);
    });
});
