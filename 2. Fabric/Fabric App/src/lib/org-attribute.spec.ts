//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { activationByOrg } from "@/queries/adoption/activation-by-org";
import { trendHeatmap } from "@/queries/adoption/trend-heatmap";
import { modelFitByOrganization } from "@/queries/efficiency/model-fit-by-organization";
import { licensePriorityByOrg } from "@/queries/licensing/license-priority-by-org";
import { describeOrgAttribute, orgColumnRef, pickOrgAttributes, withIndefiniteArticle, withOrgAttribute } from "./org-attribute";

describe("describeOrgAttribute", () => {
    it.each([
        ["Organization", "Organization", "organization", "organizations"],
        ["officeLocation", "Office location", "office location", "office locations"],
        ["cost_centre", "Cost centre", "cost centre", "cost centres"],
        ["Country", "Country", "country", "countries"],
        ["Business Unit", "Business unit", "business unit", "business units"],
        ["BU", "BU", "BU", "BUs"],
    ])("names %s for display", (column, label, noun, plural) => {
        expect(describeOrgAttribute(column)).toEqual({ column, label, noun, plural });
    });
});

describe("withIndefiniteArticle", () => {
    it.each([
        ["organization", "an organization"],
        ["office location", "an office location"],
        ["department", "a department"],
        ["cost centre", "a cost centre"],
        ["business unit", "a business unit"],
        ["unit", "a unit"],
        ["user group", "a user group"],
        ["HR team", "an HR team"],
        ["BU", "a BU"],
        ["SBU", "an SBU"],
        ["UK region", "a UK region"],
        ["hourly band", "an hourly band"],
    ])("reads %s as %s", (phrase, expected) => {
        expect(withIndefiniteArticle(phrase)).toBe(expected);
    });
});

describe("pickOrgAttributes", () => {
    // The live demo model's org table, as COLUMNSTATISTICS reports it.
    const live = [
        { column: "RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61", cardinality: 260, maxLength: undefined },
        { column: "Organization", cardinality: 6, maxLength: 9 },
        { column: "PersonId", cardinality: 260, maxLength: 24 },
        { column: "PersonId_Normalized", cardinality: 260, maxLength: 24 },
        { column: "officeLocation", cardinality: 5, maxLength: 9 },
        { column: "Function", cardinality: 6, maxLength: 20 },
        { column: "Location", cardinality: 5, maxLength: 9 },
    ];

    it("keeps groupings, drops identifiers, and leads with Organization", () => {
        expect(pickOrgAttributes(live, 260)).toEqual(["Organization", "Function", "Location", "officeLocation"]);
    });

    it("drops columns with one value or one value per person", () => {
        const stats = [
            { column: "Country", cardinality: 1, maxLength: 2 },
            { column: "JobTitle", cardinality: 9000, maxLength: 40 },
            { column: "Region", cardinality: 4, maxLength: 6 },
            { column: "Headcount", cardinality: 3, maxLength: undefined },
        ];
        expect(pickOrgAttributes(stats, 10000)).toEqual(["Region"]);
    });

    it("recognises identifiers without catching ordinary words", () => {
        const stats = ["ManagerId", "manager_id", "UserPrincipalName", "mail", "Paid", "Grid"].map((column) => ({
            column,
            cardinality: 5,
            maxLength: 10,
        }));
        expect(pickOrgAttributes(stats, 100)).toEqual(["Grid", "Paid"]);
    });
});

describe("withOrgAttribute", () => {
    const location = describeOrgAttribute("officeLocation");

    it("leaves Organization queries untouched", () => {
        const config = activationByOrg();
        expect(withOrgAttribute(config, describeOrgAttribute("Organization"))).toBe(config);
    });

    it("rebinds the DAX, the result key and every Organization label", () => {
        const rebound = withOrgAttribute(activationByOrg(), location);

        expect(rebound.query).not.toContain("[Organization]");
        expect(rebound.query).toContain(orgColumnRef("officeLocation"));
        expect(rebound.columnMetadata["Chat + Agent Org Data[officeLocation]"]).toEqual({
            name: "Chat + Agent Org DataOrganization",
            displayName: "Office location",
        });
        expect(JSON.stringify(rebound.vegaLiteSpec)).not.toContain('"title":"Organization"');
    });

    it.each([
        ["trendHeatmap", () => trendHeatmap()],
        ["licensePriorityByOrg", () => licensePriorityByOrg()],
    ])("rebinds %s completely", (_name, factory) => {
        const rebound = withOrgAttribute(factory(), location);
        expect(rebound.query).not.toContain("'Chat + Agent Org Data'[Organization]");
    });

    it("escapes a closing bracket in a column name", () => {
        expect(orgColumnRef("Team [EMEA]")).toBe("'Chat + Agent Org Data'[Team [EMEA]]]");
    });

    it("groups Model Fit by the chosen attribute", () => {
        const { query } = modelFitByOrganization(location);
        expect(query).toContain(orgColumnRef("officeLocation"));
        expect(query).toContain("Unassigned office location");
    });
});
