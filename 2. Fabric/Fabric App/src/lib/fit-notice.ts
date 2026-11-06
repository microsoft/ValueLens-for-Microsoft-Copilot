//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { workWeightGrade, type GradeRule } from "./grading-method";

export interface FitNoticeGrade {
    grade: GradeRule;
    /** The rule in the model's words, at the current grading setting. */
    rule: string;
}

export interface FitNotice {
    grades: FitNoticeGrade[];
    /** Everything else the notice says: the caveat, the counts and the setting. */
    notes: string[];
}

// The model separates the notice's parts with runs of spaces, as the report's card lays them out.
const PART_BREAK = /\s{3,}/;
const GRADE_PART = /^([A-Za-z][A-Za-z ]*?)\s*·\s*(.+)$/;

function gradeFor(label: string): GradeRule | undefined {
    return workWeightGrade(label) ?? workWeightGrade(`${label} fit`);
}

/**
 * Splits the model's `Usage Efficiency: Fit Rule Notice` into its grade rules
 * ("STRONG · spans apps, …") and the plain sentences after them. Text that
 * does not follow that layout comes back whole as a note.
 */
export function parseFitNotice(text: string | undefined): FitNotice {
    const grades: FitNoticeGrade[] = [];
    const notes: string[] = [];
    for (const part of (text ?? "").split(PART_BREAK)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const match = GRADE_PART.exec(trimmed);
        const grade = match ? gradeFor(match[1]) : undefined;
        if (match && grade) grades.push({ grade, rule: match[2].replace(/\.$/, "") });
        else notes.push(trimmed);
    }
    return { grades, notes };
}
