//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import { shortMonth } from "@/lib/month-over-month";

/** How the two monthly charts are shaped so they line up month for month. */
export interface MonthlyTrendParams {
    /** The month labels, oldest first, as the specs print them (`May 2026`). Fixes the x axis. */
    months?: readonly string[];
    /** The first day of the first month in the date range (`2026-05-01`); earlier months are faded. */
    rangeMonth?: string;
    /** Fills in series order; the spec's light-theme colours when omitted or the wrong length. */
    colors?: readonly string[];
}

/** How much a month before the date range is faded, so the range reads first. */
export const FADED_OPACITY = 0.35;

/** A month's label as the specs print it with `timeFormat(..., '%b %Y')`. */
export function monthLabel(isoMonth: string): string {
    return `${shortMonth(isoMonth)} ${isoMonth.slice(0, 4)}`;
}

/** The ISO date a calculate can compare a `Month Start` against, rejecting anything else. */
function isoDay(value: string): string | undefined {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * Applies the shared x axis, the fade and the colours to a copy of a monthly
 * stacked-bar spec. Both trends take the same months, so the hours and the
 * credits bars sit under each other.
 */
export function shapeMonthlyTrend(base: unknown, params: MonthlyTrendParams = {}): VisualizationSpec {
    const spec = structuredClone(base) as MutableTrendSpec;

    if (params.months?.length) spec.encoding.x.scale.domain = [...params.months];

    const rangeMonth = params.rangeMonth ? isoDay(params.rangeMonth) : undefined;
    const emphasis = spec.transform.find((step) => step.as === "Emphasis");
    if (emphasis && rangeMonth) {
        // ISO strings sort as dates: `2026-04-01T00:00:00` < `2026-05-01`.
        emphasis.calculate = `datum['Month Start'] < '${rangeMonth}' ? ${FADED_OPACITY} : 1`;
    }

    const color = spec.layer[0].encoding.color;
    if (params.colors?.length === color.scale.domain.length) color.scale.range = [...params.colors];

    return spec as unknown as VisualizationSpec;
}

/** Narrow view of the monthly specs covering only the parts this module rewrites. */
interface MutableTrendSpec {
    transform: { calculate?: string; as?: string | string[] }[];
    encoding: { x: { scale: { domain?: string[] } } };
    layer: { encoding: { color: { scale: { domain: string[]; range: string[] } } } }[];
}
