//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { DEPARTMENT_ADVICE, departmentAdvice, orgEmptyDescription } from "./department-coverage";
import { describeOrgAttribute } from "./org-attribute";

const ORG = describeOrgAttribute("Organization");
const OFFICE = describeOrgAttribute("officeLocation");
const BASE = "Nobody in the current selection has a license or a task with organization recorded.";

describe("departmentAdvice", () => {
    it("says where the department comes from and how to fill the gaps, without a count", () => {
        const advice = departmentAdvice(ORG);
        expect(advice).toBe(DEPARTMENT_ADVICE);
        expect(advice).toContain("Views by department leave out everyone without one.");
        expect(advice).toContain("fill in Department on users in Microsoft Entra ID");
        expect(advice).not.toMatch(/\d/);
        expect(advice).not.toContain("Workday");
    });

    it("has nothing to say for another org attribute", () => {
        expect(departmentAdvice(OFFICE)).toBeUndefined();
    });
});

describe("orgEmptyDescription", () => {
    it("says where the department comes from and how to fill it in, without a count", () => {
        const text = orgEmptyDescription(BASE, ORG);
        expect(text.startsWith(`${BASE} `)).toBe(true);
        expect(text).toContain("Department in Microsoft Entra ID");
        expect(text).toContain("fill it in there");
        expect(text.slice(BASE.length)).not.toMatch(/\d/);
        expect(text).not.toContain("Workday");
    });

    it("leaves other org attributes alone", () => {
        expect(orgEmptyDescription(BASE, OFFICE)).toBe(BASE);
    });
});
