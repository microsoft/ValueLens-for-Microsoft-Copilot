//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { applyDaxFilters } from "@/lib/dax-filters";
import { isGroupRow } from "@/lib/rollup-tree";
import { toSummaryRow } from "@/lib/summary-row";
import { toDataTable, type ColumnMetadataMap } from "@/lib/to-data-table";
import {
    ALL_USERS,
    azureMode,
    azureSolutionByService,
    azureSolutionDaily,
    azureSolutionResources,
    azureSolutionSummary,
    azureSource,
    breakdownRows,
    consumptionByProduct,
    consumptionDates,
    consumptionNotes,
    consumptionOptions,
    consumptionSources,
    COWORK_LABEL_COLUMN,
    coworkByGroup,
    coworkCreditsSummary,
    coworkWeekly,
    coworkWindowCost,
    currencyPrefix,
    foundryByModel,
    foundryDaily,
    foundryResources,
    foundryResourceSpend,
    foundrySummary,
    groupByChoices,
    groupByFilter,
    hasConsumptionData,
    isFullCoverage,
    isoDate,
    readConsumptionOptions,
    splitCoverage,
    STUDIO_LABEL_COLUMN,
    studioAgents,
    studioAzureBilling,
    studioAzureDaily,
    studioBreakdown,
    studioCreditsSummary,
    studioDaily,
    studioUsers,
    summariseFoundryInventory,
    toCoworkGroupTree,
    toStudioUserTree,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import byGroupRows from "./__fixtures__/cowork-by-group.rows.json";
import breakdownFixture from "./__fixtures__/studio-breakdown.rows.json";
import usersRows from "./__fixtures__/studio-users.rows.json";

const modules = [
    { name: "consumptionDates", factory: () => consumptionDates(), columns: liveColumns.consumptionDates },
    { name: "consumptionByProduct", factory: () => consumptionByProduct(), columns: liveColumns.consumptionByProduct },
    { name: "consumptionNotes", factory: () => consumptionNotes(), columns: liveColumns.consumptionNotes },
    { name: "consumptionSources", factory: () => consumptionSources(), columns: liveColumns.consumptionSources },
    { name: "consumptionOptions", factory: () => consumptionOptions(), columns: liveColumns.consumptionOptions },
    { name: "coworkCreditsSummary", factory: () => coworkCreditsSummary(), columns: liveColumns.coworkCreditsSummary },
    { name: "coworkWeekly (consumption)", factory: () => coworkWeekly("consumption"), columns: liveColumns.coworkWeekly },
    { name: "coworkWeekly (cost)", factory: () => coworkWeekly("cost"), columns: liveColumns.coworkWeekly },
    { name: "coworkWindowCost", factory: () => coworkWindowCost(), columns: liveColumns.coworkWindowCost },
    { name: "coworkByGroup", factory: () => coworkByGroup(), columns: liveColumns.coworkByGroup },
    { name: "studioCreditsSummary", factory: () => studioCreditsSummary(), columns: liveColumns.studioCreditsSummary },
    { name: "studioDaily (consumption)", factory: () => studioDaily("consumption"), columns: liveColumns.studioDaily },
    { name: "studioDaily (cost)", factory: () => studioDaily("cost"), columns: liveColumns.studioDaily },
    { name: "studioBreakdown (consumption)", factory: () => studioBreakdown("consumption"), columns: liveColumns.studioBreakdown },
    { name: "studioBreakdown (cost)", factory: () => studioBreakdown("cost"), columns: liveColumns.studioBreakdown },
    { name: "studioAzureBilling", factory: () => studioAzureBilling(), columns: liveColumns.studioAzureBilling },
    { name: "studioAzureDaily (consumption)", factory: () => studioAzureDaily("consumption"), columns: liveColumns.studioAzureDaily },
    { name: "studioAzureDaily (cost)", factory: () => studioAzureDaily("cost"), columns: liveColumns.studioAzureDaily },
    { name: "studioAgents", factory: () => studioAgents(), columns: liveColumns.studioAgents },
    { name: "studioUsers", factory: () => studioUsers(), columns: liveColumns.studioUsers },
    { name: "azureSource", factory: () => azureSource(), columns: liveColumns.azureSource },
    { name: "azureSolutionSummary", factory: () => azureSolutionSummary(), columns: liveColumns.azureSolutionSummary },
    { name: "azureSolutionDaily", factory: () => azureSolutionDaily(), columns: liveColumns.azureSolutionDaily },
    { name: "azureSolutionByService", factory: () => azureSolutionByService(), columns: liveColumns.azureSolutionByService },
    { name: "azureSolutionResources", factory: () => azureSolutionResources(), columns: liveColumns.azureSolutionResources },
    { name: "foundrySummary", factory: () => foundrySummary(), columns: liveColumns.foundrySummary },
    { name: "foundryDaily", factory: () => foundryDaily(), columns: liveColumns.foundryDaily },
    { name: "foundryByModel", factory: () => foundryByModel(), columns: liveColumns.foundryByModel },
    { name: "foundryResources", factory: () => foundryResources(), columns: liveColumns.foundryResources },
    { name: "foundryResourceSpend", factory: () => foundryResourceSpend(), columns: liveColumns.foundryResourceSpend },
];

type SpecFactory = () => { columnMetadata: ColumnMetadataMap; vegaLiteSpec: unknown };

const specModules: { name: string; factory: SpecFactory }[] = modules.filter(
    (module): module is (typeof modules)[number] & { factory: SpecFactory } => "vegaLiteSpec" in module.factory(),
);

type FixtureRow = Record<string, unknown>;

function fixtureTable(rows: FixtureRow[], columns: readonly string[], columnMetadata: ColumnMetadataMap) {
    return toDataTable(
        { columns: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => row[name])) } as never,
        columnMetadata,
    );
}

function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

/** Every `field` a spec reads, and every field its transforms create. */
function collectFields(node: unknown, found = { read: new Set<string>(), made: new Set<string>() }) {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") found.read.add(value);
            else if (key === "as") [value].flat().forEach((name) => typeof name === "string" && found.made.add(name));
            else if (key === "fold" && Array.isArray(value)) value.forEach((name) => found.read.add(String(name)));
            else collectFields(value, found);
        }
    }
    return found;
}

describe("consumption query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name reads the Consumption Central connection", ({ factory }) => {
        expect(factory().connection).toBe("cc");
    });

    it.each(modules)("$name ships a DAX query without a byte-order mark", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.replace(/^(\s*\/\/.*\r?\n)+/, "").trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
    });

    it.each(modules)("$name still parses once the page's slicers wrap it", ({ factory }) => {
        const wrapped = applyDaxFilters(factory().query, [groupByFilter(undefined)]);
        expect(wrapped).toContain("CALCULATETABLE(");
        expect(wrapped).toContain(`TREATAS({"${ALL_USERS}"}, 'Group By'[Attribute])`);
    });
});

describe("consumption spec field references", () => {
    it.each(specModules)("$name only reads columns the query returns or its transforms make", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const { read, made } = collectFields(vegaLiteSpec);
        const available = new Set([...Object.values(columnMetadata).map((def) => def.name), ...made]);
        for (const field of read) {
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/"timeUnit"/);
    });

    it("gives each lens its own chart from the same query", () => {
        expect(coworkWeekly("cost").query).toBe(coworkWeekly("consumption").query);
        expect(coworkWeekly("cost").vegaLiteSpec).not.toEqual(coworkWeekly("consumption").vegaLiteSpec);
        expect(studioDaily("cost").vegaLiteSpec).not.toEqual(studioDaily("consumption").vegaLiteSpec);
        expect(studioBreakdown("cost").vegaLiteSpec).not.toEqual(studioBreakdown("consumption").vegaLiteSpec);
        expect(studioAzureDaily("cost").query).toBe(studioAzureDaily("consumption").query);
        expect(studioAzureDaily("cost").vegaLiteSpec).not.toEqual(studioAzureDaily("consumption").vegaLiteSpec);
    });

    it("keeps Azure-billed pay-as-you-go out of shared queries, since older models have no CopilotPaygSpend", () => {
        const shared = modules.filter((module) => !module.name.startsWith("studioAzure"));
        for (const module of shared) expect(module.factory().query).not.toContain("CopilotPaygSpend");
        // The period has to reach [Studio Period Days], so it is read inside EVALUATE, not in a DEFINE VAR.
        for (const source of [studioAzureBilling(), studioAzureDaily()]) {
            expect(source.query).not.toMatch(/^\s*DEFINE\b/m);
            expect(source.query).toMatch(/EVALUATE\s+VAR WindowDays = \[Studio Period Days\]/);
        }
    });
});

describe("consumption slicers", () => {
    const options = readConsumptionOptions({
        columns: [{ name: "Kind" }, { name: "Value" }, { name: "Sort" }],
        rows: [
            ["Cowork period", "Current period (4 weeks)", 1],
            ["Cowork period", "Last 8 weeks", 2],
            ["Group by", "All users", 0],
            ["Group by", "City", 0],
            ["Group by", "Department", 0],
            ["Group by", "id", 0],
            ["Group by", "Job Family", 0],
            ["Group by", "Manager_User Id", 0],
            ["Group by", "Usage Intensity (Cowork)", 0],
            ["Group by", "Usage Intensity (GitHub)", 0],
            ["Group by", "Usage Intensity (Studio)", 0],
            ["Group by", "User", 0],
            ["Group by", "User Id", 0],
            ["Service", "Cowork", 0],
            ["Service", "WorkIQ", 0],
            ["Studio period", "Last 7 days", 1],
            ["Cost basis", "Actual", 0],
        ],
    });

    it("sorts the model's choices into one list per slicer, in the model's order", () => {
        expect(options.coworkPeriods).toEqual(["Current period (4 weeks)", "Last 8 weeks"]);
        expect(options.studioPeriods).toEqual(["Last 7 days"]);
        expect(options.services).toEqual(["Cowork", "WorkIQ"]);
        expect(options.costBases).toEqual(["Actual"]);
    });

    it("offers each product its own usage intensity and hides identifier groupings", () => {
        expect(groupByChoices(options.groupBy, "Cowork")).toEqual([
            { value: "City", label: "City" },
            { value: "Department", label: "Department" },
            { value: "Job Family", label: "Job family" },
            { value: "Usage Intensity (Cowork)", label: "Usage intensity" },
        ]);
        expect(groupByChoices(options.groupBy, "Studio").map((choice) => choice.value)).toContain(
            "Usage Intensity (Studio)",
        );
    });

    it("always narrows Group By to one attribute, All users by default", () => {
        expect(groupByFilter(undefined)).toBe(`TREATAS({"All users"}, 'Group By'[Attribute])`);
        expect(groupByFilter("Department")).toBe(`TREATAS({"Department"}, 'Group By'[Attribute])`);
    });

    it("reads the model's date-times as ISO dates", () => {
        expect(isoDate("2026-04-14T00:00:00")).toBe("2026-04-14");
        expect(isoDate(null)).toBeUndefined();
    });
});

describe("consumption overview", () => {
    it("splits coverage into its status and the source's own dates", () => {
        expect(splitCoverage("Partial date coverage | source 2026-05-03 to 2026-07-26")).toEqual({
            status: "Partial date coverage",
            source: "2026-05-03 to 2026-07-26",
        });
        expect(isFullCoverage(splitCoverage("Date span covered | source 2026-05-10 to 2026-08-07"))).toBe(true);
        expect(splitCoverage("")).toBeUndefined();
    });

    it("counts the model as empty only when every product's source is", () => {
        expect(hasConsumptionData({ "[Cowork Rows]": 1500, "[Studio Rows]": 810, "[Azure Rows]": 1698 })).toBe(true);
        expect(hasConsumptionData({ "[Cowork Rows]": null, "[Studio Rows]": 12, "[Azure Rows]": null })).toBe(true);
        expect(hasConsumptionData({ "[Cowork Rows]": null, "[Studio Rows]": null, "[Azure Rows]": null })).toBe(false);
    });
});

describe("cowork group tree", () => {
    const { columnMetadata } = coworkByGroup();
    const tree = toCoworkGroupTree(fixtureTable(byGroupRows, liveColumns.coworkByGroup, columnMetadata));

    it("lists the groups largest first, each holding its people", () => {
        expect(tree.rows.map((row) => row[COWORK_LABEL_COLUMN])).toEqual(["IT", "Sales", "Finance", "HR", "Marketing", "Legal"]);
        expect(tree.rows.every(isGroupRow)).toBe(true);
        for (const group of tree.rows) {
            const credits = (group._children ?? []).map((row) => row["Credits Used"] as number);
            expect(credits).toEqual([...credits].sort((a, b) => b - a));
        }
    });

    it("keeps the model's total, with pay-as-you-go allocated only at tenant level", () => {
        expect(tree.total?.Users).toBe(150);
        expect(tree.total?.["PAYG Cost"]).toBeGreaterThan(0);
        expect(tree.rows.every((row) => row["PAYG Cost"] === 0)).toBe(true);
    });

    it("names people from the org data, then the billing export, and keeps namesakes apart", () => {
        const [total, group] = byGroupRows as FixtureRow[];
        const person = (signIn: string | null, name: string | null, billingName: string | null): FixtureRow => ({
            ...group,
            "Org[DisplayName]": name,
            "Org[UserPrincipalName]": signIn,
            "[Is Group Total]": false,
            "[Users]": 1,
            "[Billing Name]": billingName,
        });
        const people = toCoworkGroupTree(
            fixtureTable(
                [
                    total,
                    group,
                    person("alexw@contoso.com", "Alex Wilber", "alexw"),
                    person("alex.wilber@contoso.com", "Alex Wilber", "alex.wilber"),
                    person("meganb@contoso.com", null, "Megan Bowen"),
                    person("leeg@contoso.com", null, null),
                    person(null, null, "Unrelated Name"),
                ],
                liveColumns.coworkByGroup,
                columnMetadata,
            ),
        ).rows[0]._children;
        expect(people?.map((row) => row[COWORK_LABEL_COLUMN])).toEqual([
            "Alex Wilber",
            "Alex Wilber",
            "Megan Bowen",
            "leeg@contoso.com",
            "(No value)",
        ]);
        expect(new Set(people?.map((row) => row._id)).size).toBe(5);
    });
});

describe("studio user tree", () => {
    const { columnMetadata } = studioUsers();
    const tree = toStudioUserTree(fixtureTable(usersRows, liveColumns.studioUsers, columnMetadata));

    it("holds every user under the one All users group by default", () => {
        expect(tree.rows.map((row) => row[STUDIO_LABEL_COLUMN])).toEqual([ALL_USERS]);
        expect((tree.rows[0]._children ?? []).length).toBe(usersRows.length - 2);
        expect(tree.total?.["Credits Used"]).toBe(tree.rows[0]["Credits Used"]);
    });
});

describe("studio breakdown", () => {
    const { columnMetadata } = studioBreakdown();
    const table = fixtureTable(breakdownFixture, liveColumns.studioBreakdown, columnMetadata);

    it("splits one result between the model and feature charts", () => {
        const models = breakdownRows(table, "Model");
        const features = breakdownRows(table, "Feature");
        expect(models.rows.length + features.rows.length).toBe(table.rows.length);
        expect(models.rows.length).toBeGreaterThan(0);
        expect(features.rows.length).toBeGreaterThan(0);
    });
});

describe("azure source", () => {
    const row = (values: unknown[]) =>
        toSummaryRow({ columns: liveColumns.azureSource.map((name) => ({ name })), rows: [values] } as never);

    it("reads the whole-solution feed when it has rows", () => {
        expect(azureMode(row([12, "GBP|USD", 2287, "USD"]))).toEqual({ kind: "solution", currencies: ["GBP", "USD"] });
    });

    it("falls back to Foundry spend when the solution feed is empty", () => {
        expect(azureMode(row([null, null, 2287, "USD"]))).toEqual({ kind: "foundry", currency: "USD" });
        expect(azureMode(row([null, null, null, null]))).toEqual({ kind: "none" });
    });

    it("prints a symbol for common currencies and the code for the rest", () => {
        expect(currencyPrefix("USD")).toBe("$");
        expect(currencyPrefix("CHF")).toBe("CHF ");
        expect(currencyPrefix(undefined)).toBe("");
    });
});

describe("Foundry inventory from Azure Resource Graph", () => {
    const { query, columnMetadata } = foundryResourceSpend();

    it("reads the latest snapshot and matches resource ids without a relationship", () => {
        expect(query).toContain("MAX('Foundry Resources'[SnapshotDate])");
        expect(query).toContain("LOWER('AzureSolutionSpend'[ResourceId])");
        expect(query).toContain('LEFT([@Id], LEN(__Id) + 1) = __Id & "/"');
        expect(query).toContain("[Azure Selected Cost]");
    });

    it("checks subscription coverage across every currency", () => {
        expect(query).toContain("REMOVEFILTERS('AzureSolutionSpend'[Currency])");
        expect(query).toContain("'Foundry Resources'[SubscriptionId] IN __Covered");
    });

    it("sums the accounts and lists the subscriptions the cost export misses", () => {
        const columns = liveColumns.foundryResourceSpend;
        const table = fixtureTable(
            [
                { "[Resource]": "a", "[Subscription]": "s1", "[Projects]": 2, "[Network]": "Public", "[Cost Export]": "Covered", "[Cost]": 10.5 },
                { "[Resource]": "b", "[Subscription]": "s2", "[Projects]": 0, "[Network]": "Private", "[Cost Export]": "Not covered", "[Cost]": null },
                { "[Resource]": "c", "[Subscription]": "s2", "[Projects]": 1, "[Network]": "Public", "[Cost Export]": "Not covered", "[Cost]": null },
            ],
            columns,
            columnMetadata,
        );
        expect(summariseFoundryInventory(table)).toEqual({
            accounts: 3,
            projects: 3,
            publicNetwork: 2,
            cost: 10.5,
            uncoveredSubscriptions: ["s2"],
            uncoveredAccounts: 2,
        });
        expect(summariseFoundryInventory(fixtureTable([], columns, columnMetadata))).toBeUndefined();
    });
});