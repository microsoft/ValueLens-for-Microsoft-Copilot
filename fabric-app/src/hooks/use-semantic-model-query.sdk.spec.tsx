//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { StrictMode, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { FabricClient, type CachedQueryResult, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryError } from "@/components/query-states";
import { PrefetchContext } from "@/hooks/prefetch.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { BUSY_MESSAGE, QueryScheduler, onModelRecovered, scheduledProxy, type QuerySchedulerOptions } from "@/lib/query-scheduler";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

// The app's own scheduler isn't the one below: a busy card hears its model recover from any scheduler.
vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

const THROTTLED = { error: { code: "TooManyRequests", message: "Too many requests" } };
const ANSWER = { results: [{ tables: [{ rows: [{ "[Value]": 1 }] }] }] };

type Transport = "async" | "direct";

/** The real SDK and scheduler, with Power BI replaced by `reply`, answering in an async function or a bare promise. */
function setup(
    reply: (model: string, query: string) => unknown,
    options: QuerySchedulerOptions = {},
    transport: Transport = "async",
) {
    const scheduler = new QueryScheduler({ random: () => 0, log: () => {}, ...options });
    const answer = (data: unknown) => ({ requestId: "r", data });
    const executeDaxJson = vi.fn((_workspace: string, model: string, query: string): Promise<unknown> => {
        if (transport === "async") return (async () => answer(await reply(model, query)))();
        const out = reply(model, query);
        return out instanceof Promise ? out.then(answer) : Promise.resolve(answer(out));
    });
    const inner = {
        semanticModel: { executeDax: vi.fn(), executeDaxJson },
        lakehouse: { executeSql: vi.fn() },
        warehouse: { executeSql: vi.fn() },
    } as unknown as IFabricApiProxy;
    state.client = new FabricClient({
        proxy: scheduledProxy(inner, scheduler),
        daxProtocol: "json",
        cache: { maxEntries: 1000 },
        semanticModels: { vl: { workspaceId: "ws", itemId: "model-a" }, cc: { workspaceId: "ws", itemId: "model-b" } },
    } as FabricClientConfig);
    const sent = (query: string) => executeDaxJson.mock.calls.filter((call) => call[2] === query).length;
    return { scheduler, executeDaxJson, sent, client: state.client as FabricClient };
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("useSemanticModelQuery when its card goes", () => {
    it("stops asking a throttled model once the only card waiting has gone, and caches nothing for it", async () => {
        let reply: unknown = THROTTLED;
        const { scheduler, executeDaxJson } = setup(() => reply);
        const card = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);

        card.unmount();
        await tick(60_000);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 0 });

        reply = ANSWER;
        const next = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(next.result.current.data).toMatchObject({ status: "success", fromCache: false });
        expect(executeDaxJson).toHaveBeenCalledTimes(2);
    });

    it("keeps trying for a card still showing the same query", async () => {
        let reply: unknown = THROTTLED;
        const { executeDaxJson } = setup(() => reply);
        const one = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        const two = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(0);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);

        reply = ANSWER;
        one.unmount();
        await tick(500);
        expect(two.result.current.data).toMatchObject({ status: "success" });
        expect(executeDaxJson).toHaveBeenCalledTimes(2);
    });
});

describe("useSemanticModelQuery after Power BI was busy", () => {
    it("asks a busy card's own query again once its model answers Try again on another card, and leaves other models' cards alone", async () => {
        const throttling = new Set(["model-a", "model-b"]);
        const { sent } = setup((model) => (throttling.has(model) ? THROTTLED : ANSWER));
        const options = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "OPTIONS" }));
        const summary = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "SUMMARY" }));
        const other = renderHook(() => useSemanticModelQuery({ connection: "cc", query: "CREDITS" }));
        // Every card gives up, then each model's last pause runs out.
        await tick(90_000);
        for (const card of [options, summary, other]) expect(card.result.current.error?.message).toBe(BUSY_MESSAGE);
        const before = { summary: sent("SUMMARY"), credits: sent("CREDITS") };

        throttling.clear();
        act(() => void options.result.current.refetch());
        await tick(0);

        expect(options.result.current.data).toMatchObject({ status: "success" });
        expect(sent("SUMMARY")).toBe(before.summary + 1);
        expect(summary.result.current.data).toMatchObject({ status: "success", fromCache: false });
        expect(summary.result.current.error).toBeUndefined();
        expect(summary.result.current.isLoading).toBe(false);
        expect(sent("CREDITS")).toBe(before.credits);
        expect(other.result.current.error?.message).toBe(BUSY_MESSAGE);
    });

    it("clears a busy card hidden behind the page's busy card once Try again on the page's card finds the model answering", async () => {
        let throttling = true;
        const { executeDaxJson, sent } = setup(() => (throttling ? THROTTLED : ANSWER));
        // As the Executive summary: the page's filter choices hold back the stages, which still ask for the summary.
        function Page() {
            const summary = useSemanticModelQuery({ connection: "vl", query: "SUMMARY" });
            const options = useSemanticModelQuery({ connection: "vl", query: "OPTIONS" });
            if (options.error) return <QueryError message={options.error.message} onRetry={options.refetch} />;
            if (summary.error) return <QueryError message={summary.error.message} onRetry={summary.refetch} />;
            return <p>{summary.data?.status === "success" ? "The bottom line" : "Loading"}</p>;
        }
        render(<Page />);
        await tick(90_000);
        expect(screen.getAllByText("Power BI is busy")).toHaveLength(1);
        const before = executeDaxJson.mock.calls.length;
        const summaries = sent("SUMMARY");

        throttling = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await tick(0);

        const after = executeDaxJson.mock.calls.slice(before).map((call) => call[2]);
        expect(after).toEqual(["OPTIONS", "SUMMARY"]);
        expect(sent("SUMMARY")).toBe(summaries + 1);
        expect(screen.getByText("The bottom line")).toBeTruthy();
        expect(screen.queryByText("Power BI is busy")).toBeNull();
    });

    it("leaves a card alone that never showed the busy message, and a card that has gone", async () => {
        let throttling = true;
        const { sent } = setup((_model, query) => (throttling && query !== "FINE" ? THROTTLED : ANSWER));
        const fine = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "FINE" }));
        const gone = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "GONE" }));
        const options = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "OPTIONS" }));
        await tick(90_000);
        expect(gone.result.current.error?.message).toBe(BUSY_MESSAGE);
        const before = { fine: sent("FINE"), gone: sent("GONE") };

        gone.unmount();
        throttling = false;
        act(() => void options.result.current.refetch());
        await tick(0);

        expect(options.result.current.data).toMatchObject({ status: "success" });
        expect(fine.result.current.data).toMatchObject({ status: "success" });
        expect(sent("FINE")).toBe(before.fine);
        expect(sent("GONE")).toBe(before.gone);
    });

    it("asks again when its model answers in the same moment the card gives up", async () => {
        let release!: (data: unknown) => void;
        const probe = new Promise((resolve) => {
            release = resolve;
        });
        const { client, sent } = setup((_model, query) => (query === "SEED" ? THROTTLED : query === "PROBE" ? probe : ANSWER), {
            maxRetries: 0,
        });
        await client.semanticModel("vl").query("SEED");
        await tick(500);
        const probing = client.semanticModel("vl").query("PROBE");
        await tick(0);
        const card = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "WAITING" }));
        await tick(0);
        expect(sent("WAITING")).toBe(0);

        // The card's wait runs out as the probe's answer arrives: the model recovers before the card shows busy.
        await act(async () => {
            vi.advanceTimersByTime(60_000);
            release(ANSWER);
            await Promise.resolve();
        });
        await tick(0);
        await probing;
        await tick(0);

        expect(sent("WAITING")).toBe(1);
        expect(card.result.current.data).toMatchObject({ status: "success", fromCache: false });
        expect(card.result.current.error).toBeUndefined();
    });

    it("shows a query error that only quotes the busy wording as that error, and doesn't send it again when the model recovers", async () => {
        const message = "Query (5, 59) Cannot find table '<oii>Power BI is busy</oii>'.";
        let throttling = false;
        const { client, sent } = setup(
            (_model, query) => (query === "MISSING" ? { error: { code: "3241803779", message } } : throttling ? THROTTLED : ANSWER),
            { maxRetries: 0 },
        );
        function Card() {
            const missing = useSemanticModelQuery({ connection: "vl", query: "MISSING" });
            return missing.error ? <QueryError message={missing.error.message} onRetry={missing.refetch} /> : <p>Loading</p>;
        }
        render(<Card />);
        await tick(0);
        expect(screen.queryByText("Power BI is busy")).toBeNull();
        expect(screen.getByText(message)).toBeTruthy();

        const notices: string[] = [];
        const stop = onModelRecovered((model) => notices.push(model));
        throttling = true;
        await act(async () => void (await client.semanticModel("vl").query("TRIGGER")));
        throttling = false;
        await tick(60_000);
        await act(async () => void (await client.semanticModel("vl").query("HEALTH")));
        await tick(0);
        stop();

        expect(notices).toEqual(["ws/model-a"]);
        expect(sent("MISSING")).toBe(1);
        expect(screen.queryByText("Power BI is busy")).toBeNull();
    });
});

describe("useSemanticModelQuery when several cards share a query their model was busy for", () => {
    const transports: Transport[] = ["async", "direct"];
    const timings = ["before", "at", "after"] as const;
    const shapes = [
        { busy: 1, waiting: 1 },
        { busy: 2, waiting: 1 },
        { busy: 1, waiting: 2 },
    ];
    const probes = ["client", "card"] as const;
    const cases = transports.flatMap((transport) =>
        timings.flatMap((timing) => shapes.flatMap((shape) => probes.map((probe) => ({ transport, timing, probe, ...shape })))),
    );

    it.each(cases)(
        "clears $busy busy and $waiting waiting cards once the model answers a $probe $timing their wait runs out ($transport)",
        async ({ transport, timing, probe, busy, waiting }) => {
            let release!: (data: unknown) => void;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            let healthy = false;
            const { client, sent } = setup(
                (_model, query) => (query === "PROBE" ? gate : healthy ? ANSWER : THROTTLED),
                { maxRetries: 0 },
                transport,
            );
            const mount = () => renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
            const cards = Array.from({ length: busy }, mount);
            await tick(0);
            for (const card of cards) expect(card.result.current.error?.message).toBe(BUSY_MESSAGE);

            // Another query tries the model, and new cards for the same query wait behind it.
            await tick(500);
            const probing =
                probe === "client"
                    ? client.semanticModel("vl").query("PROBE")
                    : renderHook(() => useSemanticModelQuery({ connection: "vl", query: "PROBE" }));
            await tick(0);
            cards.push(...Array.from({ length: waiting }, mount));
            await tick(0);
            expect(sent("Q")).toBe(1);

            const answer = () => {
                healthy = true;
                release(ANSWER);
            };
            if (timing === "before") {
                await tick(58_000);
                await act(async () => {
                    answer();
                    await Promise.resolve();
                });
            } else if (timing === "at") {
                await act(async () => {
                    vi.advanceTimersByTime(60_000);
                    answer();
                    await Promise.resolve();
                });
            } else {
                await tick(61_000);
                for (const card of cards) expect(card.result.current.error?.message).toBe(BUSY_MESSAGE);
                await act(async () => {
                    answer();
                    await Promise.resolve();
                });
            }
            await tick(0);
            if (probe === "client") await probing;
            await tick(60_000);

            for (const card of cards) {
                expect(card.result.current.data).toMatchObject({ status: "success" });
                expect(card.result.current.error).toBeUndefined();
                expect(card.result.current.isLoading).toBe(false);
            }
            expect(sent("Q")).toBeLessThanOrEqual(1 + cards.length);
            const settled = sent("Q");
            await tick(180_000);
            expect(sent("Q")).toBe(settled);
        },
    );

    it.each(transports)(
        "sends a waiting card's query once when its model answers another first but throttles it again, and clears it at the next recovery (%s)",
        async (transport) => {
            let release!: (data: unknown) => void;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            let throttling = true;
            const { client, sent } = setup(
                (_model, query) => (query === "PROBE" ? gate : query === "HEALTH" || !throttling ? ANSWER : THROTTLED),
                { maxRetries: 0 },
                transport,
            );
            await client.semanticModel("vl").query("SEED");
            await tick(500);
            const probing = client.semanticModel("vl").query("PROBE");
            await tick(0);
            const card = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
            await tick(0);
            expect(sent("Q")).toBe(0);

            // The model answers while the card waits, then throttles the card's query: that busy answer is current.
            await act(async () => {
                release(ANSWER);
                await Promise.resolve();
            });
            await tick(0);
            await probing;
            await tick(180_000);
            expect(sent("Q")).toBe(1);
            expect(card.result.current.error?.message).toBe(BUSY_MESSAGE);

            throttling = false;
            await act(async () => void (await client.semanticModel("vl").query("HEALTH")));
            await tick(0);
            expect(sent("Q")).toBe(2);
            expect(card.result.current.data).toMatchObject({ status: "success" });
            expect(card.result.current.error).toBeUndefined();
        },
    );
});

describe("useSemanticModelQuery on a page fetched ahead while Power BI was busy", () => {
    it("sends the page's query when the page is opened long after the throttle, rather than giving up at once", async () => {
        let throttling = true;
        let answerProbe!: () => void;
        const probe = new Promise<void>((resolve) => {
            answerProbe = resolve;
        });
        const { sent } = setup(async (_model, query) => {
            if (query === "PROBE") await probe;
            return throttling ? THROTTLED : ANSWER;
        });
        const ahead = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }), {
            wrapper: ({ children }) => <PrefetchContext.Provider value>{children}</PrefetchContext.Provider>,
        });
        await tick(0);
        throttling = false;
        // Fetching ahead waits for a query on screen to succeed.
        await tick(120_000);
        expect(sent("Q")).toBe(1);

        // Another card on the page tries the model first, and is still waiting for its answer.
        const other = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "PROBE" }));
        await tick(0);
        const opened = renderHook(() => useSemanticModelQuery({ connection: "vl", query: "Q" }));
        await tick(10_000);
        expect(opened.result.current.error).toBeUndefined();
        expect(opened.result.current.isLoading).toBe(true);

        answerProbe();
        await tick(0);
        expect(other.result.current.data).toMatchObject({ status: "success" });
        expect(opened.result.current.data).toMatchObject({ status: "success" });
        expect(ahead.result.current.data).toMatchObject({ status: "success" });
        expect(sent("Q")).toBe(2);
    });
});

describe("useSemanticModelQuery once a card has moved on from a query", () => {
    const OLD_ANSWER = { results: [{ tables: [{ rows: [{ "[Value]": 7777 }] }] }] };
    const NEW_ANSWER = { results: [{ tables: [{ rows: [{ "[Value]": 1111 }] }] }] };
    const OLD_ERROR = { error: { code: "3241803779", message: "Query (1, 1) Cannot find table 'Old'." } };
    const Strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const holds = (result: CachedQueryResult | undefined, value: number) =>
        result?.status === "success" && JSON.stringify(result.table).includes(String(value));
    type Props = { connection: string; query: string };

    const changes = ["model", "query", "remount", "strict"] as const;
    const positions = ["sent", "waiting"] as const;
    const lates = ["busy", "success", "error"] as const;
    const sharings = ["shared", "alone"] as const;
    const cases = (["async", "direct"] as Transport[]).flatMap((transport) =>
        changes.flatMap((change) =>
            positions.flatMap((position) =>
                lates.flatMap((late) => sharings.map((sharing) => ({ change, position, late, sharing, transport }))),
            ),
        ),
    );

    it.each(cases)(
        "keeps to its new query after a $change change while the old one was $position, which then ends $late ($sharing, $transport)",
        async ({ change, position, late, sharing, transport }) => {
            let healthy = false;
            let releaseOld!: (data: unknown) => void;
            const oldGate = new Promise((resolve) => {
                releaseOld = resolve;
            });
            let releaseProbe!: (data: unknown) => void;
            const probeGate = new Promise((resolve) => {
                releaseProbe = resolve;
            });
            const lateReply = late === "busy" ? THROTTLED : late === "success" ? OLD_ANSWER : OLD_ERROR;
            let olds = 0;
            const { client, sent } = setup(
                (_model, query) => {
                    if (query === "SEED") return THROTTLED;
                    if (query === "PROBE") return probeGate;
                    if (query === "HEALTH") return ANSWER;
                    if (query === "OLD") {
                        olds++;
                        if (olds === 1 && !healthy) return position === "sent" ? oldGate : lateReply;
                        return healthy ? OLD_ANSWER : THROTTLED;
                    }
                    return healthy ? NEW_ANSWER : THROTTLED;
                },
                { maxRetries: 0 },
                transport,
            );

            // Waiting: the model throttled, and another query is trying it, so the old query is never sent before the change.
            if (position === "waiting") {
                await client.semanticModel("vl").query("SEED");
                await tick(500);
                void client.semanticModel("vl").query("PROBE");
                await tick(0);
            }
            const peer = sharing === "shared" ? renderHook(() => useSemanticModelQuery({ connection: "vl", query: "OLD" })) : undefined;
            const history: Array<{ query: string; data: CachedQueryResult | undefined; error: string | undefined }> = [];
            const mount = (initialProps: Props) =>
                renderHook(
                    (props: Props) => {
                        const out = useSemanticModelQuery(props);
                        history.push({ query: props.query, data: out.data, error: out.error?.message });
                        return out;
                    },
                    { initialProps, wrapper: change === "strict" ? Strict : undefined },
                );
            let card = mount({ connection: "vl", query: "OLD" });
            await tick(0);
            expect(sent("OLD")).toBe(position === "sent" ? 1 : 0);

            const to = change === "query" ? { connection: "vl", query: "NEW" } : { connection: "cc", query: "NEW" };
            const changed = history.length;
            if (change === "remount") {
                card.unmount();
                card = mount(to);
            } else {
                card.rerender(to);
            }
            await tick(0);

            // The old query ends after the change: its answer, or its busy give-up, comes late.
            if (position === "sent") {
                await act(async () => {
                    releaseOld(lateReply);
                    await Promise.resolve();
                });
                await tick(0);
            } else if (late === "busy") {
                await tick(61_000);
            } else {
                await act(async () => {
                    releaseProbe(ANSWER);
                    await Promise.resolve();
                });
                await tick(0);
            }

            // Both models answer again, the new query's first: that alone must clear the card.
            healthy = true;
            const recover = async (connection: string) => {
                if (connection === "vl") {
                    await act(async () => {
                        releaseProbe(ANSWER);
                        await Promise.resolve();
                    });
                }
                let check!: Promise<unknown>;
                act(() => {
                    check = client.semanticModel(connection).query("HEALTH");
                });
                await tick(30_000);
                await act(async () => void (await check));
                await tick(60_000);
            };
            await recover(to.connection);

            const now = card.result.current;
            expect(holds(now.data, 1111)).toBe(true);
            expect(now.error).toBeUndefined();
            expect(now.isLoading).toBe(false);
            for (const shown of history.slice(changed).filter(({ query }) => query === "NEW")) {
                expect(JSON.stringify(shown.data ?? null)).not.toContain("7777");
                expect(shown.error ?? "").not.toContain("'Old'");
            }

            if (to.connection !== "vl") await recover("vl");
            if (peer) {
                if (late === "error") {
                    expect(peer.result.current.error?.message).toContain("'Old'");
                } else {
                    expect(holds(peer.result.current.data, 7777)).toBe(true);
                    expect(peer.result.current.error).toBeUndefined();
                }
                expect(peer.result.current.isLoading).toBe(false);
            }

            expect(sent("NEW")).toBeLessThanOrEqual(2);
            expect(sent("OLD")).toBeLessThanOrEqual(peer ? 2 : 1);
            if (!peer && position === "waiting") expect(sent("OLD")).toBe(0);
            const settled = { old: sent("OLD"), new: sent("NEW") };
            await tick(180_000);
            expect({ old: sent("OLD"), new: sent("NEW") }).toEqual(settled);
        },
    );
});

describe("useSemanticModelQuery in the background lane", () => {
    function gate() {
        let open!: () => void;
        const shut = new Promise<void>((resolve) => {
            open = resolve;
        });
        return { shut, open };
    }
    type Props = { background: boolean };

    it("waits while a query on screen loads, and moves on screen, sent once, when it stops being background", async () => {
        const probe = gate();
        const { scheduler, sent } = setup(async (_model, query) => {
            if (query === "PROBE") await probe.shut;
            return ANSWER;
        });
        renderHook(() => useSemanticModelQuery({ connection: "vl", query: "PROBE" }));
        const card = renderHook((props: Props) => useSemanticModelQuery({ connection: "vl", query: "Q", ...props }), {
            initialProps: { background: true },
        });
        await tick(0);
        expect(sent("Q")).toBe(0);
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });

        card.rerender({ background: false });
        await tick(0);
        expect(sent("Q")).toBe(1);
        expect(card.result.current.data).toMatchObject({ status: "success" });
        expect(card.result.current.error).toBeUndefined();
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 0 });

        probe.open();
        await tick(60_000);
        expect(sent("Q")).toBe(1);
    });

    it("keeps a background query already sent: the card reads its answer rather than sending it again", async () => {
        const answer = gate();
        const { sent } = setup(async (_model, query) => {
            if (query === "Q") await answer.shut;
            return ANSWER;
        });
        const card = renderHook((props: Props) => useSemanticModelQuery({ connection: "vl", query: "Q", ...props }), {
            initialProps: { background: true },
        });
        await tick(0);
        expect(sent("Q")).toBe(1);

        card.rerender({ background: false });
        await tick(0);
        answer.open();
        await tick(0);
        expect(card.result.current.data).toMatchObject({ status: "success" });
        expect(sent("Q")).toBe(1);
    });

    it("stays in the background on a page fetched ahead, background or not", async () => {
        const probe = gate();
        const { scheduler, sent } = setup(async (_model, query) => {
            if (query === "PROBE") await probe.shut;
            return ANSWER;
        });
        renderHook(() => useSemanticModelQuery({ connection: "vl", query: "PROBE" }));
        const card = renderHook((props: Props) => useSemanticModelQuery({ connection: "vl", query: "Q", ...props }), {
            initialProps: { background: true },
            wrapper: ({ children }) => <PrefetchContext.Provider value>{children}</PrefetchContext.Provider>,
        });
        await tick(0);
        card.rerender({ background: false });
        await tick(0);
        expect(sent("Q")).toBe(0);
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });

        probe.open();
        await tick(0);
        expect(sent("Q")).toBe(1);
    });
});
