//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import template from "./model-fit-verdicts.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Segment]": { name: "Segment", displayName: "Segment" },
    "[Main Model]": { name: "Main Model", displayName: "Main model" },
    "[Main Reason]": { name: "Main Reason", displayName: "Main reason" },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Judged Sessions]": { name: "Judged Sessions", displayName: "Judged sessions", format: FORMAT_WHOLE },
    "[Well-matched Sessions]": { name: "Well-matched Sessions", displayName: "Good match", format: FORMAT_WHOLE },
    "[Over-specified Sessions]": { name: "Over-specified Sessions", displayName: "Lighter model may do", format: FORMAT_WHOLE },
    "[Under-specified Sessions]": { name: "Under-specified Sessions", displayName: "Try stronger", format: FORMAT_WHOLE },
    "[Judged Share]": { name: "Judged Share", displayName: "Judged", format: FORMAT_PERCENT },
    "[Well-matched Share]": { name: "Well-matched Share", displayName: "Good match", format: FORMAT_PERCENT },
    "[Over-specified Share]": { name: "Over-specified Share", displayName: "Lighter model may do", format: FORMAT_PERCENT },
    "[Under-specified Share]": { name: "Under-specified Share", displayName: "Try stronger", format: FORMAT_PERCENT },
};

/** The report's verdict names; the measures keep their older Well-matched / Over- / Under-specified names. */
export type ModelFitVerdict = "Good match" | "Lighter model may do" | "Try stronger" | "Not judged";

export interface ModelFitVerdictCounts {
    judgedSessions: number | null | undefined;
    overSpecifiedSessions: number | null | undefined;
    underSpecifiedSessions: number | null | undefined;
}

function count(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Rebuilds the report's Verdict Icon choice without its hardcoded SVG colours. */
export function deriveModelFitVerdict({
    judgedSessions,
    overSpecifiedSessions,
    underSpecifiedSessions,
}: ModelFitVerdictCounts): ModelFitVerdict {
    const judged = count(judgedSessions);
    if (judged < 5) return "Not judged";

    const over = count(overSpecifiedSessions);
    const under = count(underSpecifiedSessions);
    const well = judged - over - under;

    if (well >= over && well >= under) return "Good match";
    return over >= under ? "Lighter model may do" : "Try stronger";
}

export function modelFitVerdictsFor(groupingColumn: string, blankLabel: string) {
    return {
        connection,
        query: template
            .replaceAll("__GROUPING_COLUMN__", groupingColumn)
            .replaceAll("__BLANK_LABEL__", blankLabel.replaceAll('"', '""')),
        columnMetadata,
    };
}
