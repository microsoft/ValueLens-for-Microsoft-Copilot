//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pageStages } from "@/hooks/stage-filter.context";
import { destinations, openStage, type StageId } from "./destinations";
import { StageTabs } from "./stage-tabs";

const stages: { id: StageId; label: string }[] = [
    { id: "adoption", label: "Adoption" },
    { id: "activation", label: "Activation" },
    { id: "habit-formation", label: "Habit formation" },
];

function renderTabs(open: StageId = "activation") {
    const onOpen = vi.fn();
    render(<StageTabs label="Adoption stages" stages={stages} open={open} onOpen={onOpen} />);
    return { onOpen, tabs: screen.getAllByRole("tab") };
}

describe("StageTabs", () => {
    it("is a named tab list with the open stage selected and the only tab in the tab order", () => {
        const { tabs } = renderTabs();
        expect(screen.getByRole("tablist", { name: "Adoption stages" })).toBeTruthy();
        expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
        expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    });

    it("opens a stage on click", () => {
        const { onOpen, tabs } = renderTabs();
        fireEvent.click(tabs[2]);
        expect(onOpen).toHaveBeenCalledWith("habit-formation");
    });

    it.each([
        ["ArrowRight", "habit-formation"],
        ["ArrowLeft", "adoption"],
        ["Home", "adoption"],
        ["End", "habit-formation"],
    ])("moves with %s", (key, expected) => {
        const { onOpen, tabs } = renderTabs();
        fireEvent.keyDown(tabs[1], { key });
        expect(onOpen).toHaveBeenCalledWith(expected);
        expect(document.activeElement?.textContent).toBe(stages.find((stage) => stage.id === expected)?.label);
    });

    it("wraps at either end", () => {
        const { onOpen, tabs } = renderTabs("habit-formation");
        fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
        expect(onOpen).toHaveBeenLastCalledWith("adoption");
        fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
        expect(onOpen).toHaveBeenLastCalledWith("habit-formation");
    });

    it("ignores other keys", () => {
        const { onOpen, tabs } = renderTabs();
        fireEvent.keyDown(tabs[1], { key: "a" });
        expect(onOpen).not.toHaveBeenCalled();
    });

    it("stays out of print", () => {
        renderTabs();
        expect(screen.getByRole("tablist").getAttribute("data-print")).toBe("hide");
    });
});

describe("openStage", () => {
    const adoption = destinations.find((destination) => destination.id === "adoption")!;

    it("opens the first built stage by default", () => {
        expect(openStage(adoption)).toBe(adoption.stages.find((stage) => stage.ready)?.id);
    });

    it("opens the stage asked for when the destination has it", () => {
        expect(openStage(adoption, "habit-formation")).toBe("habit-formation");
    });

    it("falls back to the first built stage for a stage from elsewhere", () => {
        expect(openStage(adoption, "leaderboard")).toBe(openStage(adoption));
    });

    it("has nothing to open when no stage is built", () => {
        expect(openStage({ stages: adoption.stages.map((stage) => ({ ...stage, ready: false })) })).toBeUndefined();
    });
});

describe("pageStages", () => {
    it("shows only the open stage, outside a pack", () => {
        const filter = pageStages("activation");
        expect(filter.show("activation")).toBe(true);
        expect(filter.show("adoption")).toBe(false);
        expect(filter.inPack).toBe(false);
    });

    it("shows every stage for a whole-page download", () => {
        const filter = pageStages("all");
        expect(stages.every((stage) => filter.show(stage.id))).toBe(true);
        expect(filter.inPack).toBe(false);
    });
});
