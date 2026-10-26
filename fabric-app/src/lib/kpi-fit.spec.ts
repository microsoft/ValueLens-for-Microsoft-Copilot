//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";
import { figureEms, FIT_SHARE, fitFontSize } from "@/lib/kpi-fit";

/** The app's layout, from app-shell.tsx and the stages' KPI grids. */
const NAV = 248;
const SCROLLBAR = 17;
const PAGE_MAX = 1400;
const PAGE_PADDING = 2 * 28;
const GAP = 12;
const CARD_INSET = 2 * 20 + 2;
const HERO = 32;
/** The smallest a figure may be drawn and still read as the card's headline: half as big again as body text. */
const READABLE = 20;

/** The width a card gives its figure in a row of `across` cards. */
function cardWidth(viewport: number, across: number): number {
    const page = Math.min(viewport - NAV - SCROLLBAR, PAGE_MAX) - PAGE_PADDING;
    return (page - GAP * (across - 1)) / across - CARD_INSET;
}

/** The most cards a row holds at each width: three from 768 px, six from 1280 px. */
const densest = (viewport: number) => (viewport >= 1280 ? 6 : viewport >= 768 ? 3 : 1);
/** Most pages hold four or five: four from 1280 px, two below. */
const usual = (viewport: number) => (viewport >= 1280 ? 5 : 2);

/** What the card draws: its usual size, or smaller to fit. */
const drawnAt = (text: string, width: number) => Math.min(HERO, (FIT_SHARE * width) / figureEms(text));

const WIDTHS = [768, 1024, 1280, 1366, 1440, 1920];

/** A large tenant's figures, about 20,000 people. */
const LARGE: Array<[string, number, KpiFormat, string?]> = [
    ["tasks", 5_906_850, "whole"],
    ["seats", 15_447, "whole"],
    ["people", 20_312, "whole"],
    ["credits", 12_480_000, "whole"],
    ["expert hours", 412_345.6, "hours"],
    ["value", 4_812_345, "currency", "$"],
    ["billed", 4_812_345.67, "money", "$"],
    ["spend", 845_210.4, "money", "$"],
    ["sessions a person", 23.45, "rate"],
    ["share", 0.734, "percent"],
    ["return", 12.3, "multiple"],
];
const figures = [
    ...LARGE.map(([name, value, format, prefix]) => ({ name, value, format, prefix })),
    ...LARGE.filter(([, , format]) => format !== "percent").map(([name, value, format, prefix]) => ({
        name: `${name} ×10`,
        value: value * 10,
        format,
        prefix,
    })),
];

describe("KPI figures fit their cards", () => {
    for (const viewport of WIDTHS) {
        it.each(figures)(`$name stays readable in the densest row at ${viewport} px`, ({ value, format, prefix }) => {
            const text = formatKpi(value, format, { prefix, compact: true });
            expect(drawnAt(text, cardWidth(viewport, densest(viewport))), text).toBeGreaterThanOrEqual(READABLE);
        });
    }

    it.each([1366, 1440, 1920])("a large tenant's figures draw at full size in a usual row at %i px", (viewport) => {
        for (const { value, format, prefix } of figures.slice(0, LARGE.length)) {
            const text = formatKpi(value, format, { prefix, compact: true });
            expect(drawnAt(text, cardWidth(viewport, usual(viewport))), text).toBe(HERO);
        }
    });

    it("would overflow the densest row without shortening", () => {
        const text = formatKpi(5_906_850, "whole");
        expect(text).toBe("5,906,850");
        expect(figureEms(text) * HERO).toBeGreaterThan(cardWidth(1366, 6));
    });

    it("draws the figure no wider than the card", () => {
        expect(fitFontSize("5.9M", "--text-hero-800")).toBe("min(var(--text-hero-800), calc(95cqi / 2.36))");
        expect(fitFontSize("", "--text-hero-900")).toContain("calc(95cqi / 1.00)");
    });

    it("never takes a figure as narrower than its glyphs", () => {
        expect(figureEms("5,906,850")).toBeCloseTo(7 * 0.58 + 2 * 0.3);
        expect(figureEms("$4.8M")).toBeCloseTo(3 * 0.58 + 0.3 + 0.9);
    });
});
