//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { ContextType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { onlyStages, StageFilterContext, type StageFilter } from "@/hooks/stage-filter.context";
import { TaskTimesContext } from "@/hooks/task-times.context";
import { ThemeContext } from "@/hooks/theme.context";
import { defaultFilters, FILTER_KEYS, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { withPriority } from "@/lib/query-priority";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import { isBusy } from "@/lib/report-export";
import type { SavedTaskTime } from "@/lib/settings-store";
import { withTaskTimes } from "@/queries/assumptions/task-times";
import { executiveHoursRange, executiveRecentMonths, executiveSummary } from "@/queries/executive";
import { ExecutiveScreen } from ".";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

vi.mock("@/lib/runtime-config", async (original) => ({
    ...(await original<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({ rayfin: {}, semanticModels: { vl: { workspaceId: "ws", itemId: "model" } } }),
}));

vi.mock("@/components/commercial-terms-provider", () => ({
    CommercialTermsProvider: ({ children }: { children: ReactNode }) => children,
}));

const SUMMARY = executiveSummary().query;
/** The bottom line's hours range, asked beside the summary. */
const RANGE = executiveHoursRange().query;
/** One task's own times, saved in the app: the summary at them is another query. */
const SAVED: readonly SavedTaskTime[] = [{ task: "Summarise a meeting", low: 5, typical: 10, high: 20 }];
const TIMED = withTaskTimes(SUMMARY, SAVED);
const TIMED_RANGE = withTaskTimes(RANGE, SAVED);
/** The trend with no date filter, which finds its own six months; at the saved times it's another query too. */
const RECENT = executiveRecentMonths().query;
const RECENT_TIMED = withTaskTimes(RECENT, SAVED);
const OPENING = onlyStages(["the-bottom-line", "is-it-growing"]);
const EVERY_STAGE = onlyStages(["the-bottom-line", "is-it-growing", "where-it-is-landing", "what-needs-attention"]);
const isTrend = (query: string | undefined) => query?.includes('"Month Start"') === true;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const FILTERS: ContextType<typeof FilterContext> = {
    filters: defaultFilters,
    setFilters: () => undefined,
    options: { agentTypes: [], agentNames: [], activities: [], firstDate: "2026-05-08", lastDate: "2026-07-06" },
    optionsError: undefined,
    applicable: [],
    orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
    orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
    orgValues: undefined,
};

function answerTable(query: string): ArrayBuffer {
    const columns: Record<string, unknown[]> =
        query === SUMMARY
            ? { "[Hours]": [4321], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }
            : query === TIMED
              ? { "[Hours]": [5555], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }
              : query === RANGE
                ? { "[Hours Conservative]": [1234], "[Hours Optimistic]": [5678] }
                : query === TIMED_RANGE
                  ? { "[Hours Conservative]": [2222], "[Hours Optimistic]": [7777] }
                  : { "[Value]": [] as string[] };
    return tableToIPC(tableFromArrays(columns), "stream").slice().buffer;
}

/** The bottom line's range row: a placeholder until the range has answered for the hours on show. */
const rangeLine = () => screen.getByText("Conservative to Optimistic").parentElement as HTMLElement;

/** The real SDK and scheduler with one slot, so a queue forms; each query is held until `answerNext()`. */
function setup() {
    const sent: string[] = [];
    const held: Array<() => void> = [];
    const executeDax = vi.fn(
        (_workspace: string, _model: string, query: string) =>
            new Promise<{ requestId: string; data: ArrayBuffer }>((resolve) => {
                sent.push(query);
                held.push(() => resolve({ requestId: "r", data: answerTable(query) }));
            }),
    );
    const inner = { semanticModel: { executeDax } } as unknown as IFabricApiProxy;
    const scheduler = new QueryScheduler({ concurrency: 1, log: () => {} });
    state.client = new FabricClient({
        proxy: scheduledProxy(inner, scheduler),
        daxProtocol: "arrow",
        cache: { maxEntries: 1000 },
        semanticModels: { vl: { workspaceId: "ws", itemId: "model" } },
    } as FabricClientConfig);
    return { sent, scheduler, answerNext: () => held.shift()?.() };
}

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ theme, isDark: false, toggleTheme: () => {} }}>{children}</ThemeContext.Provider>;
}

/** The page as it first opens, by default its bottom line and trend: the app's saved task times may still be on their way. */
function page(
    taskTimes: "loading" | "ready",
    saved: readonly SavedTaskTime[] = [],
    stages: StageFilter = OPENING,
    filters: ContextType<typeof FilterContext> = FILTERS,
) {
    return (
        <FilterContext.Provider value={filters}>
            <TaskTimesContext.Provider value={{ status: taskTimes, saved, save: () => Promise.resolve() }}>
                <Themed>
                    <StageFilterContext.Provider value={stages}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </TaskTimesContext.Provider>
        </FilterContext.Provider>
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("Executive summary on a cold open", () => {
    it("asks the bottom line, its hours range and the trend from the first query, ahead of the queries already waiting", async () => {
        const { sent, scheduler, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        // None waits for the task times: the hours, their range and the trend are each asked at the model's own, in that order.
        expect(sent).toEqual([SUMMARY]);
        expect(scheduler.activity().foreground).toBe(3);

        // Meanwhile the page's other cards ask, and wait behind them for the only slot.
        const model = (state.client as FabricClient).semanticModel("vl");
        const others = ["A", "B", "C"].map((name) => `EVALUATE ROW("${name}", 1)`);
        for (const query of others) void model.query(query);
        await tick(0);
        expect(sent).toEqual([SUMMARY]);
        expect(scheduler.activity().foreground).toBe(6);

        // None are saved, so each waits for the query already on its way.
        rerender(page("ready"));
        await tick(0);
        expect(scheduler.activity().foreground).toBe(6);
        expect(sent).toEqual([SUMMARY]);

        // The hours show as soon as they land; their range holds a placeholder until it lands too.
        answerNext();
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(within(rangeLine()).getByRole("status")).toBeTruthy();
        expect(sent).toEqual([SUMMARY, RANGE]);

        answerNext();
        await tick(0);
        expect(within(rangeLine()).getByText("1,234 – 5,678")).toBeTruthy();
        for (let answered = 2; answered < 5; answered++) {
            answerNext();
            await tick(0);
        }
        expect(sent).toEqual([SUMMARY, RANGE, RECENT, ...others]);
    });

    it("asks the trend at the model's own task times while the app's are still loading", async () => {
        // Pins the trend's `speculate`: without it, the trend would wait for the task times like any other card.
        const { sent, answerNext } = setup();
        render(page("loading"));
        await tick(0);
        for (let answered = 0; answered < 2; answered++) {
            answerNext();
            await tick(0);
        }
        expect(sent).toEqual([SUMMARY, RANGE, RECENT]);
    });

    it("asks the trend before the activity's dates are known when no date filter is set", async () => {
        const { sent, answerNext } = setup();
        render(page("ready", [], OPENING, { ...FILTERS, options: undefined }));
        await tick(0);
        for (let answered = 0; answered < 2; answered++) {
            answerNext();
            await tick(0);
        }
        expect(sent).toEqual([SUMMARY, RANGE, RECENT]);
    });

    it("waits for the activity's dates before asking the trend when a date filter is set", async () => {
        const { sent, answerNext } = setup();
        const filters: FilterState = { ...defaultFilters, dateRange: { preset: "custom", from: "2026-06-01", to: "2026-06-30" } };
        const dated = { ...FILTERS, filters };
        const { rerender } = render(page("ready", [], OPENING, { ...dated, options: undefined }));
        await tick(0);
        for (let answered = 0; answered < 2; answered++) {
            answerNext();
            await tick(0);
        }
        // Only the bottom line's hours and their range have gone.
        expect(sent).toHaveLength(2);
        expect(sent.some(isTrend)).toBe(false);

        // Once they're known, it asks for the six months to the end of the range, and no others.
        rerender(page("ready", [], OPENING, dated));
        await tick(0);
        expect(sent).toHaveLength(3);
        expect(isTrend(sent[2])).toBe(true);
        expect(sent[2]).not.toBe(RECENT);
    });

    it("shows nothing from an answer that comes before the task times, then reads it from the cache once none turn out to be saved", async () => {
        const { sent, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        answerNext();
        await tick(0);
        answerNext();
        await tick(0);
        expect(sent).toEqual([SUMMARY, RANGE, RECENT]);
        expect(screen.queryByText("4,321")).toBeNull();
        expect(screen.queryByText("1,234 – 5,678")).toBeNull();

        rerender(page("ready"));
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(within(rangeLine()).getByText("1,234 – 5,678")).toBeTruthy();
        expect(sent.filter((query) => query === SUMMARY)).toHaveLength(1);
        expect(sent.filter((query) => query === RANGE)).toHaveLength(1);
        expect(sent.filter((query) => query === RECENT)).toHaveLength(1);
    });

    it("asks the bottom line again at the task times saved in the app, and never shows the answer at the model's own", async () => {
        const { sent, answerNext } = setup();
        const { rerender } = render(page("loading"));
        await tick(0);
        expect(sent).toEqual([SUMMARY]);

        rerender(page("ready", SAVED));
        await tick(0);
        answerNext();
        await tick(0);
        // The range and the trend at the model's own times were still waiting, so they're called off before they're sent.
        expect(sent).toEqual([SUMMARY, TIMED]);
        expect(screen.queryByText("4,321")).toBeNull();

        answerNext();
        await tick(0);
        expect(screen.getByText("5,555")).toBeTruthy();
        expect(screen.queryByText("4,321")).toBeNull();
        expect(within(rangeLine()).getByRole("status")).toBeTruthy();
        expect(sent).toEqual([SUMMARY, TIMED, TIMED_RANGE]);

        answerNext();
        await tick(0);
        expect(within(rangeLine()).getByText("2,222 – 7,777")).toBeTruthy();
        expect(sent).toEqual([SUMMARY, TIMED, TIMED_RANGE, RECENT_TIMED]);
    });

    it("asks the bottom line before the queries of the stages below it", async () => {
        const { sent, scheduler } = setup();
        render(page("loading", [], EVERY_STAGE));
        await tick(0);
        expect(sent).toEqual([SUMMARY]);
        // The stages below asked too, and wait behind it.
        expect(scheduler.activity().foreground).toBeGreaterThan(1);
    });

    it("leaves the hours range unasked when the bottom line isn't on show", async () => {
        const { sent, answerNext } = setup();
        render(page("ready", [], onlyStages(["is-it-growing", "what-needs-attention"])));
        for (let answered = 0; answered < 20; answered++) {
            await tick(0);
            answerNext();
        }
        await tick(0);
        expect(sent).toContain(SUMMARY);
        expect(sent).not.toContain(RANGE);
    });

    it("keeps a download waiting until the range has landed, as it waits for any card still loading", async () => {
        const { sent, answerNext } = setup();
        render(page("ready", [], onlyStages(["the-bottom-line"])));
        await tick(0);
        answerNext();
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(sent).toEqual([SUMMARY, RANGE]);
        // What a download or report pack checks before it captures the page.
        expect(isBusy(rangeLine())).toBe(true);

        answerNext();
        await tick(0);
        expect(within(rangeLine()).getByText("1,234 – 5,678")).toBeTruthy();
        expect(isBusy(rangeLine())).toBe(false);
    });

    it("asks the hours range under the same filters as the summary", async () => {
        const { sent, answerNext } = setup();
        const filtered: ContextType<typeof FilterContext> = {
            ...FILTERS,
            filters: {
                ...defaultFilters,
                dateRange: { preset: "custom", from: "2026-06-01", to: "2026-06-30" },
                organizations: ["Finance"],
                licence: "licensed",
                agentNames: ["Helper"],
            },
            applicable: FILTER_KEYS,
        };
        render(page("ready", [], OPENING, filtered));
        for (let answered = 0; answered < 3; answered++) {
            await tick(0);
            answerNext();
        }
        await tick(0);
        const summary = sent.find((query) => query.includes('"Habitual Pct"'));
        const range = sent.find((query) => query.includes('"Hours Conservative"'));
        // The filters follow the query's body, after a comma on its own line.
        const filtersOf = (query: string | undefined) => query?.slice(query.lastIndexOf("\n,\n"));
        expect(filtersOf(summary)).toContain("DATE(2026, 6, 1)");
        expect(filtersOf(summary)).toContain('{"Finance"}');
        expect(filtersOf(summary)).toContain('{"Helper"}');
        expect(filtersOf(range)).toBe(filtersOf(summary));
    });

    it("keeps the bottom line's and the trend's places in the queue when the task times come while they wait, none saved", async () => {
        const { sent, answerNext } = setup();
        const model = (state.client as FabricClient).semanticModel("vl");
        // The app's own first queries may hold every slot as the page opens.
        const FIRST = 'EVALUATE ROW("First", 1)';
        void model.query(FIRST);
        await tick(0);
        const { rerender } = render(page("loading"));
        await tick(0);
        expect(sent).toEqual([FIRST]);

        // Another query the page's first view waits on queues behind it meanwhile.
        const LEAD = 'EVALUATE ROW("Lead", 1)';
        void withPriority("normal", () => model.query(LEAD), { lead: true });
        rerender(page("ready"));
        await tick(0);

        answerNext();
        await tick(0);
        expect(sent).toEqual([FIRST, SUMMARY]);
        answerNext();
        await tick(0);
        expect(screen.getByText("4,321")).toBeTruthy();
        expect(sent).toEqual([FIRST, SUMMARY, RANGE]);
        answerNext();
        await tick(0);
        expect(within(rangeLine()).getByText("1,234 – 5,678")).toBeTruthy();
        expect(sent).toEqual([FIRST, SUMMARY, RANGE, RECENT]);
        answerNext();
        await tick(0);
        expect(sent).toEqual([FIRST, SUMMARY, RANGE, RECENT, LEAD]);
    });
});
