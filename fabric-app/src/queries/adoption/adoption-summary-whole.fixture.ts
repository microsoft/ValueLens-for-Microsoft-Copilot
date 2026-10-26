//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * The Adoption summary as one query, exactly as rc.1 (465de3b) asked it
 * before the split: the tests prove the two parts the app now asks against it.
 */
export const WHOLE_ADOPTION_SUMMARY = [
    "EVALUATE",
    "ROW(",
    '    "Overall Users", [All Active Users],',
    '    "Overall Sessions", [Observed Sessions],',
    '    "Overall SPUW", [Observed Sessions per User per Week],',
    '    "Overall Hours Wk", [Expert Equivalent Hours Per Week],',
    '    "Overall Top Outcome", [Top Value Outcome],',
    '    "Licensed Users", [Active Licensed Users],',
    '    "Licensed SPUW", [Observed Licensed Sessions per User per Week],',
    '    "Unlicensed Users", [Active Unlicensed Users],',
    '    "Unlicensed SPUW", [Observed Unlicensed Sessions per User per Week],',
    '    "Agent Users", [Active Agent Users],',
    '    "Agent SPUW", [Observed Agent Sessions per User per Week],',
    '    "Cowork Users", [Cowork Users],',
    '    "Cowork SPUW", [Observed Cowork Sessions per User per Week],',
    '    "Cowork Hours Wk", [Cowork Expert Equivalent Hours Per Week],',
    '    "Cowork Top Outcome", [Cowork Top Value Outcome]',
    ")",
    "",
].join("\n");

/** Vite reads a query as the checkout has it: CRLF on Windows, LF on CI. */
export function lf(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

/** One column of the ROW, as `"Name", [Measure]`, wherever the query puts the ROW. */
const COLUMN = /^ {4}("[^"]+", \[[^\]]+\]),?$/;

export const isSpuw = (column: string) => / SPUW", \[/.test(column);

/** The query's columns, in order, each as its line has it. */
export function columns(query: string): string[] {
    return lf(query)
        .split("\n")
        .flatMap((line) => COLUMN.exec(line)?.[1] ?? []);
}

/** Every line of the query but its columns: what the columns sit in. */
export function frame(query: string): string[] {
    return lf(query)
        .split("\n")
        .filter((line) => !COLUMN.test(line));
}

/** The query with the five SPUW columns' lines taken out; none of them is the ROW's last. */
export function withoutSpuw(query: string): string {
    return lf(query).replace(/^ {4}"[^"]+ SPUW", \[[^\]]+\],\n/gm, "");
}
