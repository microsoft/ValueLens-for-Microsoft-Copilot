//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadStatus, readLoadStatus } from "./index";

describe("load status query", () => {
    it("reads the latest run in the Load Log table, on the ValueLens model", () => {
        const { connection, query, columnMetadata } = loadStatus();
        expect(connection).toBe("vl");
        expect(query.trim()).toMatch(/^EVALUATE\b/);
        expect(query).toContain("MAX('Load Log'[logged_at])");
        expect(query).toContain("FILTER('Load Log', 'Load Log'[logged_at] = _last)");
        expect(Object.keys(columnMetadata).sort()).toEqual(["[Activity]", "[Reason]", "[Source]", "[Status]"]);
        for (const column of ["activity", "source", "status", "reason"]) expect(query).toContain(`'Load Log'[${column}]`);
    });

    it("reads its rows as load outcomes, by column name, skipping blanks", () => {
        const table = {
            columns: [{ name: "[Status]" }, { name: "[Activity]" }, { name: "[Source]" }, { name: "[Reason]" }],
            rows: [
                ["Warning", "Run_M365_Activity_Ingester", "Microsoft 365 activity", "It ran, but found nothing to load in Sales."],
                ["Succeeded", "Run_Audit_Log_Ingester", null, ""],
                [null, "Run_Defender_Ingester", "Defender", null],
            ],
        };
        expect(readLoadStatus(table as never)).toEqual([
            {
                activity: "Run_M365_Activity_Ingester",
                source: "Microsoft 365 activity",
                status: "Warning",
                reason: "It ran, but found nothing to load in Sales.",
            },
            { activity: "Run_Audit_Log_Ingester", source: "Run_Audit_Log_Ingester", status: "Succeeded", reason: undefined },
        ]);
    });
});
