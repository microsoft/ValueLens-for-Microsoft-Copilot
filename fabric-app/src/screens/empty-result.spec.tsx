//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { Field, Schema, Table, tableToIPC, Utf8 } from "apache-arrow";
import type { ComponentType, ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorFallback } from "@/ErrorFallback";
import { ThemeContext } from "@/hooks/theme.context";
import { HttpFabricProxy } from "@/lib/http-fabric-proxy";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import { activationByOrg, trendHeatmap } from "@/queries/adoption";
import { coworkReadinessByOrg } from "@/queries/agents";
import { licensePriorityByOrg } from "@/queries/licensing";
import { taskBreakdown } from "@/queries/work";
import { ActivationStage } from "./adoption/activation-stage";
import { TrendHeatmapStage } from "./adoption/trend-heatmap-stage";
import { CoworkReadinessStage } from "./readiness/cowork-readiness-stage";
import { LicenseReadinessStage } from "./readiness/license-readiness-stage";
import { TasksStage } from "./value/tasks-stage";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

const MODELS = {
    vl: { workspaceId: "ws", itemId: "vl" },
    cc: { workspaceId: "ws", itemId: "cc" },
};

/** What Azure's executeQueries sends for a query with no rows. Its column names would have come with the rows. */
const NO_ROWS = { results: [{ tables: [{ rows: [] }] }] };

/** The heading of the root's error screen, which takes the place of the whole app. */
const CRASHED = "Something went wrong";

/** Each chart that ranks its categories, the query it asks, and what it says when that query has no rows. */
const RANKED = [
    {
        name: "Readiness: License readiness",
        Stage: LicenseReadinessStage,
        ranked: licensePriorityByOrg(),
        empty: "No unlicensed demand by organization",
    },
    {
        name: "Readiness: Cowork readiness",
        Stage: CoworkReadinessStage,
        ranked: coworkReadinessByOrg(),
        empty: "No organizations to compare",
    },
    { name: "Value: Task breakdown", Stage: TasksStage, ranked: taskBreakdown(), empty: "Nothing to break down" },
    { name: "Adoption: Activation", Stage: ActivationStage, ranked: activationByOrg(), empty: "No organizations to compare" },
    { name: "Adoption: Trend heatmap", Stage: TrendHeatmapStage, ranked: trendHeatmap(), empty: "No weekly history" },
];

/** The app's client on Azure: the SDK's JSON protocol through the same-origin API, where only `fetch` is answered here. */
function azure(): string[] {
    const sent: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
            sent.push((JSON.parse(String(init.body)) as { query: string }).query);
            return new Response(JSON.stringify(NO_ROWS), { status: 200, headers: { "content-type": "application/json" } });
        }),
    );
    state.client = new FabricClient({
        proxy: scheduledProxy(new HttpFabricProxy(async () => "token"), new QueryScheduler({ log: () => {} })),
        daxProtocol: "json",
        cache: { maxEntries: 1000 },
        semanticModels: MODELS,
    } as FabricClientConfig);
    return sent;
}

/** An Arrow answer with no rows, which still names its columns. */
function emptyArrow(columns: readonly string[]): ArrayBuffer {
    const schema = new Schema(columns.map((name) => new Field(name, new Utf8(), true)));
    return tableToIPC(new Table(schema), "stream").slice().buffer;
}

/** The app's client on Fabric: the SDK's Arrow protocol, each ranked query answered with its own columns and no rows. */
function fabric(): string[] {
    const sent: string[] = [];
    const executeDax = async (_workspace: string, _model: string, query: string) => {
        sent.push(query);
        const ranked = RANKED.find((entry) => entry.ranked.query === query)?.ranked;
        return { requestId: "r", data: emptyArrow(ranked ? Object.keys(ranked.columnMetadata) : ["[Value]"]) };
    };
    state.client = new FabricClient({
        proxy: scheduledProxy({ semanticModel: { executeDax } } as unknown as IFabricApiProxy, new QueryScheduler({ log: () => {} })),
        daxProtocol: "arrow",
        cache: { maxEntries: 1000 },
        semanticModels: MODELS,
    } as FabricClientConfig);
    return sent;
}

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ theme, isDark: false, toggleTheme: () => {} }}>{children}</ThemeContext.Provider>;
}

/** One stage under the root's error boundary, so a stage that throws shows the error screen as the app does. */
function page(Stage: ComponentType) {
    return (
        <Themed>
            <ErrorBoundary FallbackComponent={ErrorFallback}>
                <Stage />
            </ErrorBoundary>
        </Themed>
    );
}

/** Waits for the chart's empty state, or for the error screen in its place, then checks it was the empty state. */
async function expectEmptyState(empty: string) {
    await waitFor(() => expect(screen.queryByText(empty) ?? screen.queryByText(CRASHED)).not.toBeNull());
    expect(screen.queryByText(CRASHED), document.body.textContent ?? "").toBeNull();
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(screen.queryAllByRole("alert")).toEqual([]);
}

beforeEach(() => {
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
    vi.unstubAllGlobals();
});

describe("A ranked chart whose query has no rows", () => {
    describe("on Azure", () => {
        it("gets an answer with no columns from the SDK", async () => {
            const sent = azure();
            const { query } = licensePriorityByOrg();

            const result = await (state.client as FabricClient).semanticModel("vl").query(query);

            expect(sent).toEqual([query]);
            expect(result).toMatchObject({ status: "success", table: { columns: [], rows: [] } });
        });

        it.each(RANKED)("$name shows its empty state, not the error screen", async ({ Stage, ranked, empty }) => {
            const sent = azure();

            render(page(Stage));

            await expectEmptyState(empty);
            expect(sent).toContain(ranked.query);
        });
    });

    describe("on Fabric, where the answer keeps its columns", () => {
        it.each(RANKED)("$name shows its empty state, as before", async ({ Stage, ranked, empty }) => {
            const sent = fabric();

            render(page(Stage));

            await expectEmptyState(empty);
            expect(sent).toContain(ranked.query);
        });
    });
});
