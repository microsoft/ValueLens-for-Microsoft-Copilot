//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { SourceAvailabilityContext } from "@/hooks/source-availability.context";
import { ThemeContext } from "@/hooks/theme.context";
import { ALL_UNKNOWN, type SourceAvailability } from "@/lib/optional-sources";
import { FeedbackStage } from "./feedback-stage";

vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: () => ({
        data: { status: "success", table: { columns: [], rows: [] } },
        isLoading: false,
        refetch: () => undefined,
    }),
}));

function Providers({ sources, children }: { sources: SourceAvailability; children: ReactNode }) {
    return (
        <SourceAvailabilityContext.Provider value={sources}>
            <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
                {children}
            </ThemeContext.Provider>
        </SourceAvailabilityContext.Provider>
    );
}

describe("FeedbackStage", () => {
    it("explains how to turn product feedback on when the installer says it is off", () => {
        render(
            <Providers sources={{ ...ALL_UNKNOWN, productFeedback: "notConfigured" }}>
                <FeedbackStage />
            </Providers>,
        );

        expect(screen.getByText("Product feedback isn't turned on")).toBeTruthy();
        expect(screen.getByText(/tick Product feedback/)).toBeTruthy();
        expect(screen.getByText(/Files\/product_feedback/)).toBeTruthy();
    });

    it("keeps an upload hint when the module is on but no feedback has loaded", () => {
        render(
            <Providers sources={{ ...ALL_UNKNOWN, productFeedback: "present" }}>
                <FeedbackStage />
            </Providers>,
        );

        expect(screen.getByText("No feedback loaded yet")).toBeTruthy();
        expect(screen.getByText(/Microsoft 365 admin center product feedback export/)).toBeTruthy();
    });
});
