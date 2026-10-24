//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { MIN_SPARK_POINTS, sparkPath, VIEW_HEIGHT, VIEW_WIDTH, type SparkPoint } from "@/lib/sparkline";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

interface SparklineProps {
    points: readonly SparkPoint[];
    /** What the line shows, read out in place of the drawing: "Per day, Jan to Jun". */
    description: string;
    className?: string;
}

/**
 * A small line of a figure's recent run, drawn in plain SVG so a row of KPI
 * tiles costs no chart instances. It has no axis: the figure above it carries
 * the number, the line only its shape. The last point is marked.
 */
export function Sparkline({ points, description, className }: SparklineProps) {
    if (points.length < MIN_SPARK_POINTS) return null;
    const coords = sparkPath(points.map((point) => point.value));
    if (coords.length < MIN_SPARK_POINTS) return null;
    const last = coords[coords.length - 1];
    const line = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

    return (
        <span className={cn("flex items-center gap-200 text-muted-foreground", SMALL, className)}>
            <svg
                viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                preserveAspectRatio="none"
                className="h-[28px] w-full max-w-[160px] overflow-visible text-primary"
                aria-hidden="true"
                focusable="false"
                data-testid="sparkline"
            >
                <polyline
                    points={line}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
                <circle cx={last.x} cy={last.y} r={2.5} fill="currentColor" />
            </svg>
            <span aria-hidden="true" className="whitespace-nowrap">
                {points[0].label}–{points[points.length - 1].label}
            </span>
            <span className="sr-only">{description}</span>
        </span>
    );
}
