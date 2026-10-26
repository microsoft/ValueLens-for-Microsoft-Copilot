//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * How wide each character of a figure is, in ems of the semibold numeric
 * face, rounded up so the estimate is never short. Anything not listed is
 * taken as wide as a capital.
 */
const GLYPH_EMS: Record<string, number> = {
    "$": 0.58,
    "£": 0.6,
    "€": 0.6,
    ",": 0.3,
    ".": 0.3,
    " ": 0.3,
    "\u00a0": 0.3,
    "\u202f": 0.3,
    "M": 0.9,
    "%": 0.9,
    "—": 1,
    "K": 0.65,
    "B": 0.65,
    "k": 0.55,
    "<": 0.62,
    "×": 0.62,
};
const DIGIT_EMS = 0.58;
const OTHER_EMS = 0.7;

/** The width of a figure, in ems. */
export function figureEms(text: string): number {
    let ems = 0;
    for (const glyph of text) ems += /\d/.test(glyph) ? DIGIT_EMS : (GLYPH_EMS[glyph] ?? OTHER_EMS);
    return ems;
}

/** The share of the card's width a figure may take, leaving a margin for rounding. */
export const FIT_SHARE = 0.95;

/**
 * The figure's font size: its usual size, or smaller when the figure would
 * be wider than its card. The card must be a size container.
 */
export function fitFontSize(text: string, sizeVar: string): string {
    const ems = Math.max(figureEms(text), 1);
    return `min(var(${sizeVar}), calc(${FIT_SHARE * 100}cqi / ${ems.toFixed(2)}))`;
}
