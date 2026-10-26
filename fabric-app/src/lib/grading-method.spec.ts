//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { MODEL_VERDICTS, RESEARCH_GROUPS, WORK_WEIGHT_GRADES, workWeightGrade } from "./grading-method";

const sources = RESEARCH_GROUPS.flatMap((group) => group.sources);

describe("grading method", () => {
    it("names the grades and verdicts the semantic model writes", () => {
        expect(WORK_WEIGHT_GRADES.map((grade) => grade.name)).toEqual([
            "Strong fit",
            "Fair fit",
            "Worth a look",
            "Too light to grade",
        ]);
        expect(MODEL_VERDICTS.map((verdict) => verdict.name)).toEqual([
            "Good match",
            "Lighter model may do",
            "Try stronger",
            "Not judged",
        ]);
    });

    it("links every source over https, once", () => {
        expect(sources.length).toBeGreaterThanOrEqual(8);
        for (const source of sources) {
            expect(new URL(source.url).protocol).toBe("https:");
            expect(source.finding.length).toBeGreaterThan(0);
            expect(source.use.length).toBeGreaterThan(0);
        }
        expect(new Set(sources.map((source) => source.url)).size).toBe(sources.length);
    });

    it("includes OpenAI's work on complexity and tool use", () => {
        const openAi = sources.filter((source) => source.publisher === "OpenAI").map((source) => source.title);
        expect(openAi).toContain("GPT-5 System Card");
        expect(openAi).toContain("A practical guide to building agents");
    });

    it("keeps every group populated with a unique id", () => {
        expect(new Set(RESEARCH_GROUPS.map((group) => group.id)).size).toBe(RESEARCH_GROUPS.length);
        for (const group of RESEARCH_GROUPS) expect(group.sources.length).toBeGreaterThan(0);
    });

    it("reads a work weight grade under either naming", () => {
        expect(workWeightGrade("Strong fit")?.name).toBe("Strong fit");
        expect(workWeightGrade("High fit")?.name).toBe("Strong fit");
        expect(workWeightGrade("Medium fit")?.tone).toBe("neutral");
        expect(workWeightGrade("Low fit")?.name).toBe("Worth a look");
        expect(workWeightGrade(" worth a look ")?.tone).toBe("caution");
        expect(workWeightGrade("Unclassified")?.tone).toBe("none");
    });

    it("falls back to the grade's sort position for an unknown name", () => {
        expect(workWeightGrade("Great fit", 0)?.name).toBe("Strong fit");
        expect(workWeightGrade("Needs coaching", 2)?.name).toBe("Worth a look");
        expect(workWeightGrade("Something else")).toBeUndefined();
        expect(workWeightGrade(null, 9)).toBeUndefined();
    });
});
