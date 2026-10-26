//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { CompressionType, RecordBatchStreamWriter, tableFromArrays, tableToIPC } from "apache-arrow";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/filter-bar";
import { FilterProvider } from "@/components/filter-provider";
import { FilterContext } from "@/hooks/filter.context";
import { onlyStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { ThemeContext } from "@/hooks/theme.context";
import { defaultFilters } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import { executiveHoursRange, executiveSummary } from "@/queries/executive";
import { filterOptions } from "@/queries/filters";
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

const THROTTLED = "Too many requests were sent to this model. Try again later.";
const OPTIONS = filterOptions().query;
const SUMMARY = executiveSummary().query;
const RANGE = executiveHoursRange().query;
const FILTERS_FAILED = "Filter choices didn't load, so only the date presets are available.";
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Power BI's throttle: an LZ4-compressed error table in an HTTP 200. */
function throttleTable(): ArrayBuffer {
    const table = tableFromArrays({ ErrorCode: ["3241803779"], ErrorMessage: [THROTTLED], ErrorDescription: [THROTTLED] });
    return new RecordBatchStreamWriter({ compressionType: CompressionType.LZ4_FRAME }).writeAll(table).toUint8Array(true).slice().buffer;
}

function answerTable(query: string): ArrayBuffer {
    const columns: Record<string, unknown[]> =
        query === OPTIONS
            ? { "[Kind]": ["firstDate", "lastDate"], "[Value]": ["2026-05-08", "2026-07-06"] }
            : query === SUMMARY
              ? { "[Hours]": [4321], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }
              : query === RANGE
                ? { "[Hours Conservative]": [1234], "[Hours Optimistic]": [5678] }
                : { "[Value]": [] as string[] };
    return tableToIPC(tableFromArrays(columns), "stream").slice().buffer;
}

/** The real SDK and scheduler; every query to the model, or each one `throttles` picks, is throttled until `recover()`. */
function setup(throttles: (query: string) => boolean = () => true) {
    let throttling = true;
    const sent: string[] = [];
    const executeDax = vi.fn(async (_workspace: string, _model: string, query: string) => {
        sent.push(query);
        return { requestId: "r", data: throttling && throttles(query) ? throttleTable() : answerTable(query) };
    });
    const inner = { semanticModel: { executeDax } } as unknown as IFabricApiProxy;
    state.client = new FabricClient({
        proxy: scheduledProxy(inner, new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} })),
        daxProtocol: "arrow",
        cache: { maxEntries: 1000 },
        semanticModels: { vl: { workspaceId: "ws", itemId: "model" } },
    } as FabricClientConfig);
    return {
        sent,
        recover: () => {
            throttling = false;
        },
    };
}

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ theme, isDark: false, toggleTheme: () => {} }}>{children}</ThemeContext.Provider>;
}

const card = (name: string) => screen.getByRole("heading", { name }).closest("section") as HTMLElement;

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

describe("Executive summary after Power BI was busy", () => {
    it("clears the bottom line hidden behind the page's busy card once Try again finds the model answering", async () => {
        const { sent, recover } = setup();
        render(
            <FilterProvider applicable={[]}>
                <Themed>
                    <StageFilterContext.Provider value={onlyStages(["the-bottom-line"])}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </FilterProvider>,
        );
        await tick(5000);
        expect(screen.queryByRole("heading", { name: "The bottom line" })).toBeNull();
        expect(sent).toContain(SUMMARY);

        recover();
        const before = sent.length;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await tick(1000);

        const after = sent.slice(before);
        expect(after[0]).toBe(OPTIONS);
        expect(after.filter((query) => query === SUMMARY)).toHaveLength(1);
        const bottomLine = card("The bottom line");
        expect(within(bottomLine).queryByText("Power BI is busy")).toBeNull();
        expect(within(bottomLine).getByText("4,321")).toBeTruthy();
        expect(within(bottomLine).getByText("1,234 – 5,678")).toBeTruthy();
    });

    it("asks the clicked card's own query first, then clears the page's other busy cards on that model", async () => {
        const { sent, recover } = setup();
        render(
            <FilterContext.Provider
                value={{
                    filters: defaultFilters,
                    setFilters: () => undefined,
                    options: { agentTypes: [], agentNames: [], activities: [], firstDate: "2026-05-08", lastDate: "2026-07-06" },
                    optionsError: undefined,
                    applicable: [],
                    orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                    orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                    orgValues: undefined,
                }}
            >
                <Themed>
                    <StageFilterContext.Provider value={onlyStages(["the-bottom-line", "is-it-growing"])}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </FilterContext.Provider>,
        );
        await tick(2000);
        expect(within(card("The bottom line")).getByText("Power BI is busy")).toBeTruthy();
        expect(within(card("Is it growing?")).getByText("Power BI is busy")).toBeTruthy();

        recover();
        const before = sent.length;
        fireEvent.click(within(card("The bottom line")).getByRole("button", { name: "Try again" }));
        await tick(1000);

        expect(sent[before]).toBe(SUMMARY);
        expect(sent.slice(before).filter((query) => query === SUMMARY)).toHaveLength(1);
        expect(within(card("The bottom line")).getByText("4,321")).toBeTruthy();
        expect(within(card("The bottom line")).getByText("1,234 – 5,678")).toBeTruthy();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
    });

    it("clears the filter bar and the page with no click once the model answers another query", async () => {
        const { sent, recover } = setup();
        render(
            <FilterProvider applicable={[]}>
                <Themed>
                    <FilterBar destinationLabel="Executive summary" />
                    <StageFilterContext.Provider value={onlyStages(["the-bottom-line"])}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </FilterProvider>,
        );
        await tick(30_000);
        expect(screen.getByText(FILTERS_FAILED)).toBeTruthy();
        expect(screen.getAllByText("Power BI is busy").length).toBeGreaterThan(0);

        recover();
        const before = sent.length;
        // Another card, or the next page opened, asks the model and gets its answer.
        await act(async () => {
            await (state.client as FabricClient).semanticModel("vl").query('EVALUATE ROW("Ping", 1)');
        });
        await tick(1000);

        const after = sent.slice(before);
        expect(after).toContain(OPTIONS);
        expect(after.filter((query) => query === SUMMARY)).toHaveLength(1);
        expect(screen.queryByText(FILTERS_FAILED)).toBeNull();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
        expect(within(card("The bottom line")).getByText("4,321")).toBeTruthy();
        expect(within(card("The bottom line")).getByText("1,234 – 5,678")).toBeTruthy();
    });

    it("keeps the hours when only their range was busy, and asks for the range alone again", async () => {
        const { sent, recover } = setup((query) => query === RANGE);
        render(
            <FilterContext.Provider
                value={{
                    filters: defaultFilters,
                    setFilters: () => undefined,
                    options: { agentTypes: [], agentNames: [], activities: [], firstDate: "2026-05-08", lastDate: "2026-07-06" },
                    optionsError: undefined,
                    applicable: [],
                    orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                    orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                    orgValues: undefined,
                }}
            >
                <Themed>
                    <StageFilterContext.Provider value={onlyStages(["the-bottom-line"])}>
                        <ExecutiveScreen />
                    </StageFilterContext.Provider>
                </Themed>
            </FilterContext.Provider>,
        );
        await tick(2000);
        const bottomLine = card("The bottom line");
        expect(within(bottomLine).getByText("4,321")).toBeTruthy();
        const rangeLine = within(bottomLine).getByText("Conservative to Optimistic").parentElement as HTMLElement;
        expect(within(rangeLine).getByText("Power BI is busy")).toBeTruthy();
        expect(within(bottomLine).getAllByRole("button", { name: "Try again" })).toHaveLength(1);

        recover();
        const before = sent.length;
        fireEvent.click(within(rangeLine).getByRole("button", { name: "Try again" }));
        await tick(1000);

        expect(sent.slice(before)).toEqual([RANGE]);
        expect(within(bottomLine).getByText("4,321")).toBeTruthy();
        expect(within(bottomLine).getByText("1,234 – 5,678")).toBeTruthy();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
    });
});
