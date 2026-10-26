//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { coworkLimitState } from "./cowork-limit";

describe("coworkLimitState", () => {
    it("treats blank allowance and headroom as no limit", () => {
        expect(coworkLimitState({ "[Allowance Used]": null, "[Policy Headroom]": null }).noLimitSet).toBe(true);
    });

    it("defensively treats a negative headroom with blank allowance as no limit", () => {
        expect(coworkLimitState({ "[Allowance Used]": null, "[Policy Headroom]": -42 }).noLimitSet).toBe(true);
    });

    it("keeps zero users over limit neutral", () => {
        expect(coworkLimitState({ "[Allowance Used]": 0.5, "[Policy Headroom]": 100, "[Users Over Limit]": 0 })).toEqual({
            allowanceUsed: 0.5,
            policyHeadroom: 100,
            usersOverLimit: 0,
            noLimitSet: false,
        });
    });
});
