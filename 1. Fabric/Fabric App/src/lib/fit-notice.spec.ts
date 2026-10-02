//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { parseFitNotice } from "./fit-notice";

// As `Usage Efficiency: Fit Rule Notice` returns it at the Balanced setting.
const BALANCED =
    "STRONG · spans apps, builds a file or uses many sources     FAIR · some sources, messages read or one app" +
    "     WORTH A LOOK · chat with nothing read or attached.   We see what a session touched, not prompts or answer" +
    " quality: a flag is a coaching prompt, not a verdict. 1,176 graded; 108 too light to grade. Grading: Balanced (Assumptions).";

describe("fit rule notice", () => {
    it("reads each grade rule under the app's grade names", () => {
        const { grades } = parseFitNotice(BALANCED);
        expect(grades.map(({ grade }) => grade.name)).toEqual(["Strong fit", "Fair fit", "Worth a look"]);
        expect(grades.map(({ rule }) => rule)).toEqual([
            "spans apps, builds a file or uses many sources",
            "some sources, messages read or one app",
            "chat with nothing read or attached",
        ]);
    });

    it("keeps the caveat, counts and setting as a note", () => {
        const { notes } = parseFitNotice(BALANCED);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/^We see what a session touched/);
        expect(notes[0]).toMatch(/Grading: Balanced \(Assumptions\)\.$/);
    });

    it("returns a notice without grade rules whole", () => {
        const text = "Nothing in this selection carries enough detail to assess.";
        expect(parseFitNotice(text)).toEqual({ grades: [], notes: [text] });
        expect(parseFitNotice(undefined)).toEqual({ grades: [], notes: [] });
    });

    it("understands the grade names of older models", () => {
        const { grades } = parseFitNotice("HIGH · many sources     LOW · chat only");
        expect(grades.map(({ grade }) => grade.name)).toEqual(["Strong fit", "Worth a look"]);
    });
});
