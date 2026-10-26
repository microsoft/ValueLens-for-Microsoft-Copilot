//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen } from "@testing-library/react";
import { FileStack } from "lucide-react";
import { describe, expect, it } from "vitest";

import { BandPopover } from "@/components/band-popover";

function renderPopover() {
    render(
        <>
            <BandPopover label="Reports" icon={FileStack}>
                {(close) => (
                    <button type="button" onClick={close}>
                        Open a pack
                    </button>
                )}
            </BandPopover>
            <p>Elsewhere</p>
        </>,
    );
    return screen.getByRole("button", { name: "Reports" });
}

describe("BandPopover", () => {
    it("opens its panel from its button", () => {
        const button = renderPopover();
        expect(button).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("button", { name: "Open a pack" })).toBeNull();

        fireEvent.click(button);

        expect(button).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("button", { name: "Open a pack" })).toBeInTheDocument();
    });

    it("closes on Escape and returns focus to its button", () => {
        const button = renderPopover();
        fireEvent.click(button);

        fireEvent.keyDown(screen.getByRole("button", { name: "Open a pack" }), { key: "Escape" });

        expect(screen.queryByRole("button", { name: "Open a pack" })).toBeNull();
        expect(button).toHaveFocus();
    });

    it("closes on a press outside it", () => {
        const button = renderPopover();
        fireEvent.click(button);

        fireEvent.pointerDown(screen.getByText("Elsewhere"));

        expect(screen.queryByRole("button", { name: "Open a pack" })).toBeNull();
    });

    it("lets its content close it", () => {
        const button = renderPopover();
        fireEvent.click(button);

        fireEvent.click(screen.getByRole("button", { name: "Open a pack" }));

        expect(button).toHaveAttribute("aria-expanded", "false");
    });
});
