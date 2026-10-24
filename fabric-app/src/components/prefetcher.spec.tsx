//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import type { ComponentProps, ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext, useFilterContext } from "@/hooks/filter.context";
import { useIsPrefetch } from "@/hooks/prefetch.context";
import { useStageFilter } from "@/hooks/stage-filter.context";
import type { AccessScopeState } from "@/lib/access-scope";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { destinations, type DestinationId } from "./destinations";
import { Prefetcher } from "./prefetcher";

const scope = vi.hoisted(() => ({ state: { kind: "off" } as AccessScopeState }));
vi.mock("@/hooks/use-access-scope", () => ({ useAccessScope: () => scope.state }));

const IDLE = 100;

function fakeScheduler() {
    let state = { foreground: 0, background: 0, finished: 0 };
    const listeners = new Set<() => void>();
    return {
        activity: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        set(next: Partial<typeof state>) {
            state = { ...state, ...next };
            act(() => listeners.forEach((listener) => listener()));
        },
    };
}

/** What each fake page saw when it mounted. */
const seen: Array<{ page: DestinationId; prefetch: boolean; applicable: readonly string[]; shows: string[]; organizations: string[] }> = [];

function fakeScreen(page: DestinationId) {
    return function Screen() {
        const prefetch = useIsPrefetch();
        const { applicable, filters } = useFilterContext();
        const stageFilter = useStageFilter();
        const stages = destinations.find((destination) => destination.id === page)!.stages;
        seen.push({
            page,
            prefetch,
            applicable,
            shows: stages.filter((stage) => stageFilter.show(stage.id)).map((stage) => stage.id),
            organizations: filters.organizations,
        });
        return <p>{page}</p>;
    };
}

const available = destinations.filter((destination) => ["executive", "adoption", "value"].includes(destination.id));
const screens = { executive: fakeScreen("executive"), adoption: fakeScreen("adoption"), value: fakeScreen("value") };

function renderPrefetcher(
    scheduler: ReturnType<typeof fakeScheduler>,
    organizations: string[] = [],
    pages: Partial<Record<DestinationId, () => ReactNode>> = screens,
) {
    return render(prefetcher(scheduler, organizations, pages));
}

function prefetcher(
    scheduler: ReturnType<typeof fakeScheduler>,
    organizations: string[] = [],
    pages: Partial<Record<DestinationId, () => ReactNode>> = screens,
) {
    const value: ComponentProps<typeof FilterContext.Provider>["value"] = {
        filters: { ...defaultFilters, organizations },
        setFilters: () => {},
        options: undefined,
        optionsError: undefined,
        applicable: [],
        orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
        orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
        orgValues: undefined,
    };
    return (
        <FilterContext.Provider value={value}>
            <Prefetcher
                available={available}
                current="executive"
                stage="the-bottom-line"
                screens={pages}
                scheduler={scheduler}
                idleMs={IDLE}
            />
        </FilterContext.Provider>
    );
}

/** Lets each idle wait fire and its update settle before the next. */
function idleFor(times: number) {
    for (let index = 0; index < times; index++) act(() => vi.advanceTimersByTime(IDLE));
}

const mounted = (container: HTMLElement) => container.querySelector("[data-prefetch]")?.getAttribute("data-prefetch");

beforeEach(() => {
    vi.useFakeTimers();
    seen.length = 0;
    scope.state = { kind: "off" };
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("Prefetcher", () => {
    it("waits for the open page to load before fetching anything", () => {
        const scheduler = fakeScheduler();
        const { container } = renderPrefetcher(scheduler);
        act(() => vi.advanceTimersByTime(IDLE * 5));
        expect(mounted(container)).toBeUndefined();

        scheduler.set({ foreground: 3 });
        act(() => vi.advanceTimersByTime(IDLE * 5));
        expect(mounted(container)).toBeUndefined();

        scheduler.set({ foreground: 0, finished: 3 });
        act(() => vi.advanceTimersByTime(IDLE - 1));
        expect(mounted(container)).toBeUndefined();
        act(() => vi.advanceTimersByTime(1));
        expect(mounted(container)).toBe("adoption/adoption");
    });

    it("mounts the next page hidden, with its own tab, slicers and the background lane", () => {
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const { container } = renderPrefetcher(scheduler, ["Finance"]);
        act(() => vi.advanceTimersByTime(IDLE));

        const holder = container.querySelector<HTMLElement>("[data-prefetch]")!;
        expect(holder.hidden).toBe(true);
        expect(holder.hasAttribute("inert")).toBe(true);
        expect(holder.getAttribute("aria-hidden")).toBe("true");
        const adoption = destinations.find((destination) => destination.id === "adoption")!;
        expect(seen.at(-1)).toEqual({
            page: "adoption",
            prefetch: true,
            applicable: adoption.filters,
            shows: ["adoption"],
            organizations: ["Finance"],
        });
    });

    it("moves on only once the page in hand has finished, and stops after the next two", () => {
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const { container } = renderPrefetcher(scheduler);
        act(() => vi.advanceTimersByTime(IDLE));
        expect(mounted(container)).toBe("adoption/adoption");

        scheduler.set({ background: 4 });
        act(() => vi.advanceTimersByTime(IDLE * 10));
        expect(mounted(container)).toBe("adoption/adoption");

        scheduler.set({ background: 0, finished: 5 });
        act(() => vi.advanceTimersByTime(IDLE));
        expect(mounted(container)).toBe("value/task-breakdown");
        act(() => vi.advanceTimersByTime(IDLE));
        expect(mounted(container)).toBeUndefined();
        idleFor(5);
        expect(mounted(container)).toBeUndefined();
        expect([...new Set(seen.map((entry) => entry.page))]).toEqual(["adoption", "value"]);
    });

    it("waits while someone is waiting on the page on screen", () => {
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const { container } = renderPrefetcher(scheduler);
        act(() => vi.advanceTimersByTime(IDLE));
        scheduler.set({ foreground: 1 });
        act(() => vi.advanceTimersByTime(IDLE * 10));
        expect(mounted(container)).toBe("adoption/adoption");
    });

    it("moves past a page that fails", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const broken = () => {
            throw new Error("no such measure");
        };
        const { container } = renderPrefetcher(scheduler, [], { ...screens, adoption: broken });
        act(() => vi.advanceTimersByTime(IDLE));
        expect(container.querySelector("[data-prefetch]")?.textContent).toBe("");
        act(() => vi.advanceTimersByTime(IDLE));
        expect(mounted(container)).toBe("value/task-breakdown");
    });

    it("starts again from the first page when the slicers change", () => {
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const { container, rerender } = renderPrefetcher(scheduler);
        idleFor(2);
        expect(mounted(container)).toBe("value/task-breakdown");

        rerender(prefetcher(scheduler, ["Finance"]));
        expect(mounted(container)).toBeUndefined();
        act(() => vi.advanceTimersByTime(IDLE));
        expect(mounted(container)).toBe("adoption/adoption");
        expect(seen.at(-1)?.organizations).toEqual(["Finance"]);
    });

    it("fetches nothing for someone with no access", () => {
        scope.state = { kind: "none" };
        const scheduler = fakeScheduler();
        scheduler.set({ finished: 1 });
        const { container } = renderPrefetcher(scheduler);
        act(() => vi.advanceTimersByTime(IDLE * 10));
        expect(mounted(container)).toBeUndefined();
        expect(seen).toHaveLength(0);
    });
});
