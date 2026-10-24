//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** One point of a sparkline: a short label, such as "Jun", and its figure. */
export interface SparkPoint {
    label: string;
    value: number;
}

/** Fewer points than this and the line says no more than the arrow beside it. */
export const MIN_SPARK_POINTS = 3;

export const VIEW_WIDTH = 120;
export const VIEW_HEIGHT = 28;
const PAD = 3;

/** The points as SVG coordinates in a 120 × 28 box, scaled to their own range. A flat series sits mid-height. */
export function sparkPath(values: readonly number[]): { x: number; y: number }[] {
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) return [];
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const span = max - min;
    const step = finite.length > 1 ? (VIEW_WIDTH - PAD * 2) / (finite.length - 1) : 0;
    return finite.map((value, index) => ({
        x: PAD + index * step,
        y: span === 0 ? VIEW_HEIGHT / 2 : PAD + (1 - (value - min) / span) * (VIEW_HEIGHT - PAD * 2),
    }));
}
