//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z?)?$/;
const ISO_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?Z?\b/g;
const monthYear = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function parse(value: string, pattern: RegExp): Date | undefined {
    const match = pattern.exec(value.trim());
    if (!match) return undefined;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A period the model returns as a date, "2026-05-01T00:00:00", read "May 2026". Anything else is left as it is. */
export function formatPeriod(value: string): string {
    const date = parse(value, ISO_DATE);
    return date ? monthYear.format(date) : value;
}

/** Text with model dates in it, "2026-10-17T00:00:00", read "17 Oct 2026". */
export function readableDates(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const date = parse(text, ISO_DATE);
    if (date) return dayMonthYear.format(date);
    return text.replace(ISO_IN_TEXT, (_, year: string, month: string, day: string) =>
        dayMonthYear.format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))),
    );
}