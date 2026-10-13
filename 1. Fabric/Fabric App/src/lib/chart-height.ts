//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

interface RowChartSizing {
    /** Height each category row gets. */
    perRow?: number;
    /** Header, legend and axes around the plot. */
    chrome?: number;
    min?: number;
}

/**
 * Height for a chart with one row per category, so a filter that narrows it
 * to one or two organizations shrinks the chart instead of stretching a
 * single bar across the whole frame.
 */
export function rowChartHeight(rows: number, { perRow = 44, chrome = 160, min = 200 }: RowChartSizing = {}): number {
    return Math.max(min, Math.max(rows, 1) * perRow + chrome);
}

/**
 * Height for a data grid that hugs a short result instead of leaving a tall
 * empty frame, and scrolls once it passes `max`.
 */
export function gridHeight(rows: number, { perRow = 32, chrome = 132, min = 240, max = 560 }: RowChartSizing & { max?: number } = {}): number {
    return Math.min(max, rowChartHeight(rows, { perRow, chrome, min }));
}
