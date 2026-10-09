//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualTheme } from "@microsoft/fabric-visuals-core";
import { ThemeContext } from "@/hooks/theme.context";
import { ShadowAiStage } from "./shadow-ai-stage";

const mocked = vi.hoisted(() => ({ statusRows: [] as unknown[][] }));

vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: (config: { query: string }) => {
        const isStatus = config.query.includes("'Defender Status'[Probe]");
        const columns = ["[Probe]", "[Status]", "[Source]", "[Rows]", "[Message]", "[Run At]"].map((name) => ({ name }));
        return {
            data: { status: "success", table: isStatus ? { columns, rows: mocked.statusRows } : { columns: [], rows: [] } },
            isLoading: false,
            refetch: () => undefined,
        };
    },
}));

function Theme({ children }: { children: ReactNode }) {
    return (
        <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme: {} as VisualTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

const row = (probe: string, status: string, message = "") => [probe, status, "graph", 0, message, "2025-01-01"];

describe("ShadowAiStage", () => {
    beforeEach(() => {
        mocked.statusRows = [];
    });

    it("explains how to turn Defender on when the installer says it is off", () => {
        render(<ShadowAiStage source="notConfigured" />);

        expect(screen.getByRole("heading", { name: "Shadow AI" })).toBeTruthy();
        expect(screen.getByText("Defender isn't turned on")).toBeTruthy();
        expect(screen.getByText(/ThreatHunting\.Read\.All/)).toBeTruthy();
    });

    it("asks to connect Defender when the model has no Defender data", () => {
        render(<ShadowAiStage source="absent" />);

        expect(screen.getByText("Connect Microsoft Defender")).toBeTruthy();
    });

    it("says Defender hasn't run when the source is on but no probe has reported", () => {
        render(
            <Theme>
                <ShadowAiStage source="present" />
            </Theme>,
        );

        expect(screen.getByText("Defender hasn't run yet")).toBeTruthy();
    });

    it("explains what to grant when Defender refused every probe", () => {
        mocked.statusRows = [row("device_activity", "forbidden"), row("cloud_discovery", "unlicensed")];
        render(
            <Theme>
                <ShadowAiStage source="present" />
            </Theme>,
        );

        expect(screen.getByText("Defender refused every probe")).toBeTruthy();
    });

    it("shows the findings with a note when only some probes loaded", () => {
        mocked.statusRows = [row("device_activity", "ok"), row("cloud_discovery", "forbidden", "403")];
        render(
            <Theme>
                <ShadowAiStage source="present" />
            </Theme>,
        );

        expect(screen.getByRole("status").textContent).toMatch(/Some of Defender didn't load/);
        expect(screen.getByText("How to read this")).toBeTruthy();
    });
});
