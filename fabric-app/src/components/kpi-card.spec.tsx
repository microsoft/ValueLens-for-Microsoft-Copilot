//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiCard, KpiStat } from "./kpi-card";
import { sparkPath } from "@/lib/sparkline";

const comparison = "Jun vs May, per day";

describe("KpiCard delta", () => {
    it("shows a rise in the positive colour with an up arrow", () => {
        render(<KpiCard label="Hours" value={1500} delta={{ direction: "up", amount: "36%", comparison }} />);
        const amount = screen.getByText("36%", { exact: false });
        expect(amount.className).toContain("text-positive");
        expect(amount.textContent).toBe("▲ Up 36%");
        expect(screen.getByText(comparison)).toBeTruthy();
    });

    it("shows a fall in the negative colour with a down arrow", () => {
        render(<KpiCard label="Satisfaction" value={0.6} format="percent" delta={{ direction: "down", amount: "3.2 pp", comparison: "Jun vs May" }} />);
        const amount = screen.getByText("3.2 pp", { exact: false });
        expect(amount.className).toContain("text-negative");
        expect(amount.textContent).toBe("▼ Down 3.2 pp");
    });

    it("keeps a neutral figure muted whichever way it moves", () => {
        render(<KpiCard label="Credits" value={2e6} delta={{ direction: "up", amount: "12%", comparison, polarity: "neutral" }} />);
        const amount = screen.getByText("12%", { exact: false });
        expect(amount.className).toContain("text-muted-foreground");
        expect(amount.className).not.toContain("text-positive");
    });

    it("drops the arrow when nothing changed", () => {
        render(<KpiCard label="Seats" value={0.66} format="percent" delta={{ direction: "flat", amount: "No change", comparison: "Jun vs May" }} />);
        const amount = screen.getByText("No change");
        expect(amount.textContent).toBe("No change");
        expect(amount.className).toContain("text-muted-foreground");
    });

    it("shows no arrow on a blank card or without a delta", () => {
        const { container, rerender } = render(<KpiCard label="Hours" value={undefined} delta={{ direction: "up", amount: "36%", comparison }} />);
        expect(container.textContent).not.toContain("36%");
        rerender(<KpiCard label="Hours" value={1500} />);
        expect(container.textContent).not.toMatch(/[▲▼]/);
    });

    it("can name a deliberate blank value", () => {
        render(<KpiCard label="Allowance used" value={undefined} emptyValue="No limit set" />);
        expect(screen.getByText("No limit set")).toBeTruthy();
    });
});

describe("KpiCard large figures", () => {
    it("shortens a figure of a million or more, and keeps the exact figure", () => {
        const { container } = render(<KpiCard label="Tasks" value={5_906_850} />);
        const figure = container.querySelector("[data-kpi-value]")!;
        expect(figure.getAttribute("title")).toBe("5,906,850");
        expect(screen.getByText("5.9M").getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByText("5,906,850").className).toContain("sr-only");
    });

    it("never wraps the figure, and sizes it to the card", () => {
        const { container } = render(<KpiCard label="Seats" value={15_447} />);
        const figure = container.querySelector("[data-kpi-value]")!;
        expect(figure.className).toContain("whitespace-nowrap");
        expect(figure.parentElement!.className).toContain("[container-type:inline-size]");
        expect(figure.textContent).toBe("15,447");
        expect(figure.hasAttribute("title")).toBe(false);
    });

    it("shortens a detail figure the same way", () => {
        render(<KpiStat label="Hours lost" value={2_345_678} format="hours" />);
        expect(screen.getByText("2.3M").parentElement!.getAttribute("title")).toBe("2,345,678");
    });
});

describe("KpiCard trend", () => {
    const points = [
        { label: "Apr", value: 10 },
        { label: "May", value: 14 },
        { label: "Jun", value: 21 },
    ];

    it("draws a sparkline with its months and a spoken summary", () => {
        render(<KpiCard label="Hours" value={1500} trend={{ points, description: "Trend by full month, Apr to Jun: higher at the end." }} />);
        expect(screen.getByTestId("sparkline").getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByText("Apr–Jun")).toBeTruthy();
        expect(screen.getByText("Trend by full month, Apr to Jun: higher at the end.").className).toContain("sr-only");
    });

    it("draws nothing below three points or without a figure", () => {
        render(<KpiCard label="Hours" value={1500} trend={{ points: points.slice(0, 2), description: "Two months" }} />);
        render(<KpiCard label="Tasks" value={undefined} trend={{ points, description: "Blank" }} />);
        expect(screen.queryByTestId("sparkline")).toBeNull();
    });
});

describe("sparkPath", () => {
    it("fills the box from the lowest to the highest value, oldest on the left", () => {
        const coords = sparkPath([5, 10, 0]);
        expect(coords.map((point) => point.x)).toEqual([3, 60, 117]);
        expect(coords[2].y).toBe(25);
        expect(coords[1].y).toBe(3);
        expect(coords[0].y).toBe(14);
    });

    it("lays a flat run at mid-height and skips gaps", () => {
        expect(sparkPath([4, 4, 4]).map((point) => point.y)).toEqual([14, 14, 14]);
        expect(sparkPath([1, Number.NaN, 3])).toHaveLength(2);
        expect(sparkPath([])).toEqual([]);
    });
});