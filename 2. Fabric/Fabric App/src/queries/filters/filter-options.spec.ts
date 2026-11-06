//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { QueryTable } from "@microsoft/fabric-app-data";
import { describe, expect, it } from "vitest";
import { PEOPLE_WITH_ACTIVITY } from "@/lib/filters";
import { filterOptions, toFilterOptions } from "./filter-options";

const column = (name: string) => ({ name, dataType: "String" });

function options(rows: [string, string][]) {
    const table: QueryTable = { columns: [column("[Kind]"), column("[Value]")], rows };
    return toFilterOptions(table);
}

describe("filter options' tenant size", () => {
    it("counts people as each query does to decide the tenant's default dates", () => {
        expect(filterOptions().query).toContain(`FORMAT(${PEOPLE_WITH_ACTIVITY}, "0")`);
    });

    it("says a tenant is large above the threshold, and small at or below it", () => {
        expect(options([["people", "20000"]]).largeTenant).toBe(true);
        expect(options([["people", "10000"]]).largeTenant).toBe(false);
        expect(options([["people", "12"]]).largeTenant).toBe(false);
    });

    it("says nothing about the size when the count didn't come back", () => {
        expect(options([["lastDate", "2026-10-04"]]).largeTenant).toBeUndefined();
        expect(options([["people", "n/a"]]).largeTenant).toBeUndefined();
    });
});
