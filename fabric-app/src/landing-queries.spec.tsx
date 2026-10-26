//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { ThemeContext } from "@/hooks/theme.context";
import { clearLoadStatus } from "@/hooks/use-load-status";
import { clearSourceFreshness } from "@/hooks/use-source-freshness";
import { useAppTheme } from "@/hooks/use-theme";
import { ACCESS_SCOPE_QUERY } from "@/lib/access-scope";
import { applyDaxFilters } from "@/lib/dax-filters";
import { filterLabel, tenantDefaultDates } from "@/lib/filters";
import { mergedSourceProbe, OPTIONAL_SOURCES } from "@/lib/optional-sources";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { currentPriority, type QueryPriority } from "@/lib/query-priority";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import { modelCommercialTerms } from "@/queries/consumption/commercial-terms";
import { executiveHoursRange, executiveRecentMonths, executiveSummary } from "@/queries/executive";
import { consumptionOrgAttributeOptions, filterOptions, orgAttributeOptions, orgValueOptions } from "@/queries/filters";
import { auditLogFreshness, loadStatus } from "@/queries/freshness";
// Loaded ahead, so the lazily loaded page mounts on the first ticks.
import "@/screens/executive";

const state = vi.hoisted(() => ({
    client: undefined as unknown,
    access: undefined as { groupId: string; rlsOrgAttribute?: string } | undefined,
    // Both models set up, as on a Fabric install with Consumption Central.
    models: {
        vl: { workspaceId: "6f1c2b9a-0d4e-4f7a-9b3c-2e5d8a1f0c47", itemId: "a3e7d2c1-5b8f-4c6a-9e0d-7f2b4c1a8e39" },
        cc: { workspaceId: "6f1c2b9a-0d4e-4f7a-9b3c-2e5d8a1f0c47", itemId: "d8b4f0e2-1c7a-4e9b-8d3f-5a6c2e0b9f71" },
    },
}));

vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

vi.mock("@/lib/runtime-config", async (original) => ({
    ...(await original<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({
        host: "fabric",
        rayfin: {},
        semanticModels: state.models,
        access: state.access,
    }),
}));

vi.mock("@/lib/settings-store", async (original) => ({
    ...(await original<typeof import("@/lib/settings-store")>()),
    getSettingsStore: () => ({
        loadCommercialTerms: async () => null,
        saveCommercialTerms: async () => {
            throw new Error("Not saved in this test.");
        },
        loadTaskTimes: async () => [],
        saveTaskTimes: async () => [],
        loadReportPacks: async () => [],
        saveReportPack: async (pack: unknown) => pack,
        deleteReportPack: async () => {},
    }),
}));

// What the app fetches ahead once the page has loaded is another test's concern.
vi.mock("@/components/prefetcher", () => ({ Prefetcher: () => null }));

const OPTIONS = filterOptions().query;
// The page starts on the tenant's default dates, which each query works out for itself.
const SUMMARY = applyDaxFilters(executiveSummary().query, [tenantDefaultDates()]);
const HOURS_RANGE = applyDaxFilters(executiveHoursRange().query, [tenantDefaultDates()]);
const PROBE = mergedSourceProbe(OPTIONAL_SOURCES);
const ORG_COLUMNS = orgAttributeOptions().query;
const ORG_VALUES = orgValueOptions(describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)).query;
const DEPARTMENT_VALUES = orgValueOptions(describeOrgAttribute("Department")).query;

/** rc.1's numbering, from the 20k cut list. */
const NAMES = new Map<string, string>([
    [auditLogFreshness().query, "c00 freshness"],
    [loadStatus().query, "c01 load status"],
    [OPTIONS, "c02 filter options"],
    [ACCESS_SCOPE_QUERY, "c03 access scope"],
    [PROBE, "sources probe"],
    [consumptionOrgAttributeOptions().query, "c05 consumption org attributes"],
    [ORG_VALUES, "c06 org values"],
    [DEPARTMENT_VALUES, "c06 department values"],
    [executiveRecentMonths().query, "c10 trend"],
    [ORG_COLUMNS, "c11 org columns"],
    [modelCommercialTerms().query, "c13 rates"],
    [SUMMARY, "c16 summary"],
    // Part of the summary in rc.1, now asked on its own.
    [HOURS_RANGE, "c16 hours range"],
]);

function named(query: string): string {
    return NAMES.get(query) ?? (query.includes('"Part"') ? "credits" : `? ${query.split("\n", 1)[0]}`);
}

type Columns = Record<string, unknown[]>;

const ANSWERS = new Map<string, Columns>([
    [OPTIONS, { "[Kind]": ["firstDate", "lastDate", "people"], "[Value]": ["2026-05-08", "2026-07-06", "20000"] }],
    [SUMMARY, { "[Hours]": [4321], "[Tasks]": [9876], "[Licensed Seats]": [20], "[Seats In Use]": [10] }],
    [HOURS_RANGE, { "[Hours Conservative]": [1234], "[Hours Optimistic]": [5678] }],
    [PROBE, Object.fromEntries(OPTIONAL_SOURCES.map((source) => [`[${source}]`, [1]]))],
    [ACCESS_SCOPE_QUERY, { "[Who]": ["#others", "*"], "[Type]": ["0", "all"], "[Value]": ["", ""] }],
]);

function answer(query: string, answers: ReadonlyMap<string, Columns>): ArrayBuffer {
    const columns = answers.get(query) ?? ANSWERS.get(query) ?? { "[Value]": [] as string[] };
    return tableToIPC(tableFromArrays(columns), "stream").slice().buffer;
}

/** The org columns' statistics, with `Organization` worth grouping by only if it has more than one value. */
const orgColumns = (organizations: number): Columns => ({
    "[Column]": [DEFAULT_ORG_ATTRIBUTE, "Department"],
    "[Cardinality]": [organizations, 12],
    "[Max Length]": [8, 20],
    "[People]": [100, 100],
});

/** Answers for the org data: two organizations, and two departments. */
function orgAnswers(organizations: number): Map<string, Columns> {
    return new Map([
        [ORG_COLUMNS, orgColumns(organizations)],
        [ORG_VALUES, { "[Value]": ["Org A", "Org B"] }],
        [DEPARTMENT_VALUES, { "[Value]": ["Finance", "Sales"] }],
    ]);
}

interface Ask {
    name: string;
    lane: QueryPriority;
}

/**
 * The real SDK and scheduler under the whole app. Records each query the app
 * asks the scheduler for, with the lane it asks in, and each query sent to the
 * model. A query named in `held` isn't answered until its gate opens. A
 * query in `answers` is answered so, rather than as {@link ANSWERS} has it.
 */
function setup(held: string[] = [], answers: ReadonlyMap<string, Columns> = new Map()) {
    const asks: Ask[] = [];
    const sent: string[] = [];
    const gates = new Map(
        held.map((name) => {
            let open!: () => void;
            const shut = new Promise<void>((resolve) => {
                open = resolve;
            });
            return [name, { shut, open }];
        }),
    );
    const executeDax = vi.fn(async (_workspace: string, _model: string, query: string) => {
        sent.push(named(query));
        await gates.get(named(query))?.shut;
        return { requestId: "r", data: answer(query, answers) };
    });
    const inner = { semanticModel: { executeDax } } as unknown as IFabricApiProxy;
    const scheduler = new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} });
    const scheduled = scheduledProxy(inner, scheduler);
    const proxy: IFabricApiProxy = {
        ...scheduled,
        semanticModel: {
            ...scheduled.semanticModel,
            executeDax: (workspace, model, query, options) => {
                asks.push({ name: named(query), lane: currentPriority() });
                return scheduled.semanticModel.executeDax(workspace, model, query, options);
            },
        },
    };
    state.client = new FabricClient({
        proxy,
        daxProtocol: "arrow",
        cache: { maxEntries: 1000 },
        semanticModels: state.models,
    } as FabricClientConfig);
    const open = (name: string) => gates.get(name)?.open();
    const inLane = (lane: QueryPriority) => [...new Set(asks.filter((ask) => ask.lane === lane).map((ask) => ask.name))].sort();
    return {
        sent,
        open,
        /** Each query asked on screen at least once. */
        onScreen: () => inLane("normal"),
        /** Each query asked in the background lane at least once. */
        inBackground: () => inLane("low"),
        /** The lane of each ask for the query `name`, in order. */
        lanes: (name: string) => asks.filter((ask) => ask.name === name).map((ask) => ask.lane),
    };
}

/** Mirrors the provider chain `main.tsx` mounts around the app. */
function Harness({ children }: { children: ReactNode }) {
    const { isDark, toggleTheme } = useAppTheme();
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ isDark, toggleTheme, theme }}>{children}</ThemeContext.Provider>;
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

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
    clearSourceFreshness();
    clearLoadStatus();
    state.access = undefined;
});

afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** What the landing page waits on, on screen. rc.1 asked 17 queries there, and 18 once the hours range was asked on its own. */
const LANDING = [
    "c00 freshness",
    "c02 filter options",
    "sources probe",
    "c10 trend",
    "c13 rates",
    "credits",
    "c16 summary",
    "c16 hours range",
];
/** Nothing on the landing page waits on these. */
const BACKGROUND = ["c01 load status", "c11 org columns"];
const ORG_MENU = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label;

function renderApp() {
    render(
        <Harness>
            <App />
        </Harness>,
    );
}

/** A filter menu's panel. */
function panelNamed(name: string): Element {
    const panel = document.querySelector(`[role="dialog"][aria-label="${name}"]`);
    if (!panel) throw new Error(`No filter menu named ${name}.`);
    return panel;
}

/** Opens a filter menu's panel, as the browser does for its popover. */
function openMenu(name: string) {
    const panel = panelNamed(name);
    const toggle = new Event("toggle");
    Object.defineProperty(toggle, "newState", { value: "open" });
    act(() => {
        panel.dispatchEvent(toggle);
    });
}

/** The choices a menu's panel offers. */
const choices = (panel: Element) => [...panel.querySelectorAll("li")].map((item) => item.textContent);
const DEPARTMENT_MENU = describeOrgAttribute("Department").label;

describe("The landing page's queries", () => {
    it("are eight on screen, with the load status and the org columns in the background", async () => {
        const { sent, onScreen, inBackground } = setup();
        renderApp();
        await tick(5000);

        expect(onScreen()).toEqual([...LANDING].sort());
        expect(inBackground()).toEqual(BACKGROUND);
        // Each is sent once. The org values and Consumption Central's org attributes wait for a filter menu.
        expect([...sent].sort()).toEqual([...LANDING, ...BACKGROUND].sort());
    });

    it("are nine on screen with access scoping on, which asks who is signed in", async () => {
        state.access = { groupId: "g", rlsOrgAttribute: "Department" };
        const { sent, onScreen, inBackground } = setup();
        renderApp();
        await tick(5000);

        expect(onScreen()).toEqual([...LANDING, "c03 access scope"].sort());
        expect(inBackground()).toEqual(BACKGROUND);
        expect([...sent].sort()).toEqual([...LANDING, ...BACKGROUND, "c03 access scope"].sort());
    });

    it("ask the same queries, once each, when the filter options say the tenant is small", async () => {
        const small = new Map([[OPTIONS, { "[Kind]": ["firstDate", "lastDate", "people"], "[Value]": ["2026-05-08", "2026-07-06", "50"] }]]);
        const { sent, onScreen } = setup([], small);
        renderApp();
        await tick(5000);

        // The default dates cover every date here, and stay as they were, so nothing is asked again.
        expect(onScreen()).toEqual([...LANDING].sort());
        expect([...sent].sort()).toEqual([...LANDING, ...BACKGROUND].sort());
        expect(screen.getByRole("button", { name: /^Date/ }).textContent).toContain("All dates");
    });

    it("start the summary on the tenant's default dates before the filter options answer", async () => {
        const { sent, open } = setup(["c02 filter options"]);
        renderApp();
        await tick(1000);
        // Named so only as asked over the default window worked out in the query.
        expect(sent).toEqual(expect.arrayContaining(["c16 summary", "c16 hours range"]));
        open("c02 filter options");
        await tick(1000);
        expect(sent.filter((name) => name === "c16 summary")).toHaveLength(1);
        expect(screen.getByRole("button", { name: /^Date/ }).textContent).toContain("Last 12 weeks");
    });

    it("start the trend with the first queries, while the credits wait for the activity's dates", async () => {
        const { sent, open } = setup(["c02 filter options"]);
        renderApp();
        await tick(1000);
        expect(sent).toEqual(expect.arrayContaining(["c10 trend", "c16 summary", "c16 hours range"]));
        expect(sent).not.toContain("credits");

        open("c02 filter options");
        await tick(1000);
        expect(sent).toContain("credits");
    });

    it("load the filter menu's choices, and the org columns on screen, once a menu other than the dates opens", async () => {
        // An answer on screen held back keeps the background lane waiting, so a move to the screen shows.
        const { sent, open, lanes } = setup(["c00 freshness"]);
        renderApp();
        await tick(1000);
        expect(lanes("c11 org columns")).toEqual(["low"]);
        expect(sent).not.toContain("c11 org columns");

        openMenu(filterLabel("dateRange", ""));
        await tick(1000);
        expect(lanes("c06 org values")).toEqual([]);
        expect(lanes("c05 consumption org attributes")).toEqual([]);
        expect(lanes("c11 org columns")).toEqual(["low"]);

        openMenu(ORG_MENU);
        await tick(1000);
        expect(lanes("c06 org values")).toEqual(["normal"]);
        expect(lanes("c05 consumption org attributes")).toEqual(["normal"]);
        expect(lanes("c11 org columns")).toEqual(["low", "normal"]);
        expect(sent).toEqual(expect.arrayContaining(["c06 org values", "c05 consumption org attributes"]));
        expect(sent.filter((name) => name === "c11 org columns")).toHaveLength(1);
        // Asked beside the org columns, then by the menu once they've settled the column: sent once.
        expect(sent.filter((name) => name === "c06 org values")).toHaveLength(1);
        open("c00 freshness");
    });

    it("hold the org values from a menu opened before the org columns load, so it never offers one column's values under another's name", async () => {
        // `Organization` has a single value here, so the org columns settle on grouping by department.
        const { sent, open } = setup(["c11 org columns"], orgAnswers(1));
        renderApp();
        await tick(5000);
        expect(sent).toContain("c11 org columns");

        openMenu(ORG_MENU);
        await tick(1000);
        const panel = panelNamed(ORG_MENU);
        // The values of the column in use until then load beside the org columns, but aren't offered.
        expect(sent).toContain("c06 org values");
        expect(choices(panel)).toEqual([]);
        expect(panel.textContent).toContain("Loading organizations");

        open("c11 org columns");
        await tick(1000);
        // The same panel, so the menu stays open, now for the column the org columns settled on.
        expect(panel.isConnected).toBe(true);
        expect(panel.getAttribute("aria-label")).toBe(DEPARTMENT_MENU);
        expect(choices(panel)).toEqual(["Finance", "Sales"]);
        expect(sent.filter((name) => name.startsWith("c06")).sort()).toEqual(["c06 department values", "c06 org values"]);
    });

    it("offer no values while those of the column Group by picked load", async () => {
        const { sent, open } = setup(["c06 department values"], orgAnswers(5));
        renderApp();
        await tick(5000);
        openMenu(ORG_MENU);
        await tick(1000);
        const panel = panelNamed(ORG_MENU);
        expect(choices(panel)).toEqual(["Org A", "Org B"]);

        openMenu("Group by");
        const department = [...panelNamed("Group by").querySelectorAll("button")].find((button) => button.textContent === DEPARTMENT_MENU);
        fireEvent.click(department!);
        await tick(1000);
        expect(sent).toContain("c06 department values");
        expect(panel.getAttribute("aria-label")).toBe(DEPARTMENT_MENU);
        expect(choices(panel)).toEqual([]);
        expect(panel.textContent).toContain("Loading departments");

        open("c06 department values");
        await tick(1000);
        expect(choices(panel)).toEqual(["Finance", "Sales"]);
    });

    it("load the org columns on screen once a breakdown by org opens", async () => {
        const { sent, open, lanes } = setup(["c00 freshness"]);
        renderApp();
        await tick(1000);
        expect(lanes("c11 org columns")).toEqual(["low"]);

        fireEvent.click(screen.getByRole("tab", { name: "Where it is landing" }));
        await tick(1000);
        expect(lanes("c11 org columns")).toEqual(["low", "normal"]);
        expect(sent.filter((name) => name === "c11 org columns")).toHaveLength(1);
        open("c00 freshness");
    });
});

describe("The band", () => {
    it("switches between the products set up, ValueLens' pages its tabs and Consumption Central's stages", async () => {
        setup();
        renderApp();
        await tick(5000);

        const productsNav = screen.getByRole("navigation", { name: "Products" });
        const products = [...productsNav.querySelectorAll("button")].map((button) => button.textContent);
        expect(products).toEqual(["ValueLens", "Consumption Central"]);
        expect(screen.getByRole("button", { name: "ValueLens" })).toHaveAttribute("aria-current", "true");

        const sections = screen.getByRole("navigation", { name: "Sections" });
        expect(sections.querySelector("[aria-current=page]")?.textContent).toBe("Summary");
        expect(sections.textContent).toContain("Adoption");
        expect(sections.textContent).not.toContain("Budget runway");
        expect(screen.getByRole("tab", { name: "The bottom line" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Consumption Central" }));
        await tick(1000);

        expect(screen.getByRole("button", { name: "Consumption Central" })).toHaveAttribute("aria-current", "true");
        const stages = screen.getByRole("navigation", { name: "Sections" });
        expect([...stages.querySelectorAll("a, button")].map((tab) => tab.textContent)).toEqual([
            "All products",
            "Budget runway",
            "Cowork / Work IQ",
            "Copilot Studio",
            "Azure",
        ]);
        expect(stages.querySelector("[aria-current=page]")?.textContent).toBe("All products");
        // The stages are the tabs, so there are no sub-views as well.
        expect(screen.queryByRole("tablist")).toBeNull();
    });
});
