//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    auditLogFreshness,
    consumptionFreshness,
    evaluatorFreshness,
    m365ActivityFreshness,
    productFeedbackFreshness,
    registryFreshness,
} from "./index";
import { liveColumns } from "./live-columns.fixture";
import auditLogRows from "./__fixtures__/audit-log-freshness.rows.json";
import consumptionRows from "./__fixtures__/consumption-freshness.rows.json";

const modules = [
    { name: "auditLogFreshness", factory: auditLogFreshness, columns: liveColumns.auditLogFreshness, connection: "vl" },
    { name: "m365ActivityFreshness", factory: m365ActivityFreshness, columns: liveColumns.m365ActivityFreshness, connection: "vl" },
    { name: "productFeedbackFreshness", factory: productFeedbackFreshness, columns: liveColumns.productFeedbackFreshness, connection: "vl" },
    { name: "registryFreshness", factory: registryFreshness, columns: liveColumns.registryFreshness, connection: "vl" },
    { name: "consumptionFreshness", factory: consumptionFreshness, columns: liveColumns.consumptionFreshness, connection: "cc" },
    { name: "evaluatorFreshness", factory: evaluatorFreshness, columns: liveColumns.evaluatorFreshness, connection: "ae" },
];

/** Characters `ColumnDef.name` strips from the original DAX column name. */
function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

describe("freshness query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets its own model", ({ factory, connection }) => {
        expect(factory().connection).toBe(connection);
    });

    it.each(modules)("$name ships a single-row DAX query", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^EVALUATE\b/);
        expect(raw).toContain("ROW(");
    });

    it.each(modules)("$name reads the data's own dates, not a date table that runs past them", ({ factory }) => {
        const { query } = factory();
        expect(query).not.toMatch(/'(Reporting )?Date'\[/);
    });

    it("reads each source's fact table", () => {
        expect(auditLogFreshness().query).toContain("MAX('Chat + Agent Interactions (Audit Logs)'[ActivityDate])");
        expect(m365ActivityFreshness().query).toContain("MAX('M365 Activity'[ActivityDate])");
        expect(productFeedbackFreshness().query).toContain("MAX('ProductFeedback'[FeedbackDate])");
        expect(registryFreshness().query).toContain("[Agent Registry Freshness]");
        expect(evaluatorFreshness().query).toContain("MAX('Agent Performance'[InteractionDate])");
        const credits = consumptionFreshness().query;
        expect(credits).toContain("MAX(CreditsWeekly[MetricDate])");
        expect(credits).toContain("MAX('Credit Consumption (Tenant)'[Usage_Date])");
        expect(credits).toContain("MAX('AzureSolutionSpend'[UsageDate])");
        expect(credits).toContain("MAX('AzureAiSpend'[UsageDate])");
    });

    it("keeps optional ValueLens sources in queries of their own, so a missing table fails alone", () => {
        for (const factory of [auditLogFreshness, m365ActivityFreshness, productFeedbackFreshness, registryFreshness]) {
            const tables = factory().query.match(/'(Chat \+ Agent Interactions \(Audit Logs\)|M365 Activity|ProductFeedback|Agents 365)'/g) ?? [];
            expect(new Set(tables).size).toBeLessThanOrEqual(1);
        }
    });
});

describe("freshness fixtures", () => {
    it("match the authored columns", () => {
        expect(Object.keys(auditLogRows[0]).sort()).toEqual([...liveColumns.auditLogFreshness].sort());
        expect(Object.keys(consumptionRows[0]).sort()).toEqual([...liveColumns.consumptionFreshness].sort());
    });
});
