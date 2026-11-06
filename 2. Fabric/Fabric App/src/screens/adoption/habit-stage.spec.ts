//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import { formatMonth } from "./habit-month";

describe("formatMonth", () => {
    it("formats a model month", () => {
        expect(formatMonth("2026-06-01T00:00:00")).toBe("June 2026");
    });

    it("treats DAX's zero date and missing values as no month", () => {
        expect(formatMonth("1899-12-30T00:00:00")).toBeUndefined();
        expect(formatMonth(undefined)).toBeUndefined();
        expect(formatMonth("")).toBeUndefined();
    });
});
