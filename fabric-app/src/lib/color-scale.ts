//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import type { OutcomeColors } from "@/hooks/use-palette-theme";

/**
 * The app's outcome tones, falling back to the theme's categorical palette
 * before the CSS variables they come from have been read.
 */
export function outcomePalette(outcomeColors: OutcomeColors | undefined, theme: VisualTheme): OutcomeColors {
    if (outcomeColors) return outcomeColors;
    const palette = theme.categoricalPalette ?? [];
    return {
        positive: palette[0] ?? theme.brandBackground,
        negative: palette[1] ?? theme.foregroundSecondary,
        caution: palette[2] ?? theme.brandForeground,
        neutral: palette[3] ?? theme.stroke,
    };
}

/**
 * A heatmap label colour: whichever of two text colours contrasts more with
 * the cell's own fill, read back from the chart's colour scale. The label
 * then stays legible at every step of any ramp, in light and dark themes.
 */
export function contrastingTextColor(field: string, first: string, second: string) {
    const fill = `scale('color', datum[${JSON.stringify(field)}])`;
    const test = `contrast(${fill}, ${JSON.stringify(first)}) >= contrast(${fill}, ${JSON.stringify(second)})`;
    return { condition: { test, value: first }, value: second };
}

/** Pins a spec's colour encoding to fixed categories and colours, so a verdict keeps its tone wherever it appears. */
export function withColorScale(
    spec: VisualizationSpec,
    domain: readonly string[],
    range: readonly string[],
): VisualizationSpec {
    const base = spec as Record<string, unknown>;
    const encoding = (base.encoding ?? {}) as Record<string, unknown>;
    const color = (encoding.color ?? {}) as Record<string, unknown>;
    const scale = (color.scale ?? {}) as Record<string, unknown>;

    return {
        ...base,
        encoding: {
            ...encoding,
            color: { ...color, scale: { ...scale, domain: [...domain], range: [...range] } },
        },
    } as unknown as VisualizationSpec;
}
