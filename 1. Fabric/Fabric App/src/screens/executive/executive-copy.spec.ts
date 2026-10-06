//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// Keith's rule for this page: no money. The figures are hours, tasks, skills
// and credits; money stays on Cost vs value, one link away.
const stages = Object.entries(
    import.meta.glob<string>(["./*.tsx", "!./*.spec.tsx"], { eager: true, query: "?raw", import: "default" }),
);

describe("Executive summary copy", () => {
    it("finds the stages", () => {
        expect(stages.length).toBeGreaterThanOrEqual(5);
    });

    it.each(stages)("%s prints no money", (_path, text) => {
        expect(text).not.toMatch(/[£€¥]|["'`]\$(?!\{)|\$\d|"currency"|\bprefix=/);
        expect(text).not.toMatch(/\b(cost|spend|price|ROI)\b(?![- ]vs[- ]value)/i);
    });
});