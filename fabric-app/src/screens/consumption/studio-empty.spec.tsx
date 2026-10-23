//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PpacExportHowTo } from "./ppac-export-how-to";
import { PPAC_URL, UPLOAD_FOLDER, studioDailyEmpty, studioTotalsEmpty } from "./studio-empty";

const NO_USAGE = /\bno (copilot studio )?(usage|credits)\b/i;

describe("Copilot Studio empty states", () => {
    it("never says there are no credits when the user snapshot has them", () => {
        for (const state of [studioTotalsEmpty(true), studioDailyEmpty(true)]) {
            expect(state.title).not.toMatch(NO_USAGE);
            expect(state.description).toMatch(/user snapshot has Copilot Studio credits/);
            expect(state.description).toMatch(/Repair or change/);
        }
    });

    it("keeps the no-credits wording when nothing has loaded", () => {
        expect(studioTotalsEmpty(false).title).toBe("No Copilot Studio credits");
        expect(studioDailyEmpty(false).title).toBe("No daily credits");
    });

    it("explains how to get the per-agent export, with a link", () => {
        render(<PpacExportHowTo what="model" />);
        const link = screen.getByRole("link", { name: /Power Platform admin center/ });
        expect(link.getAttribute("href")).toBe(PPAC_URL);
        expect(link.getAttribute("target")).toBe("_blank");
        expect(screen.getByText(UPLOAD_FOLDER)).toBeTruthy();
        expect(screen.getByText(/Per-user credits don't name a/).textContent).toMatch(/model/);
    });
});
