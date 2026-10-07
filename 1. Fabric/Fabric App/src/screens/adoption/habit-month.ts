//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "June 2026" from the model's `2026-06-01T00:00:00`. DAX's zero date (1899-12-30) means no month. */
export function formatMonth(value: string | undefined): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number(value.slice(0, 4)) < 1900) return undefined;
    return monthFormat.format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}
