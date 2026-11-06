//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiCard } from "./kpi-card";

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
