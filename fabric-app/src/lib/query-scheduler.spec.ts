//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import {
    FabricApiProxyError,
    FabricClient,
    FabricGenericProxyError,
    type FabricClientConfig,
    type IFabricApiProxy,
} from "@microsoft/fabric-app-data";
import {
    Bool,
    CompressionType,
    Field,
    Int64,
    RecordBatch,
    RecordBatchStreamWriter,
    Schema,
    Table,
    tableFromArrays,
    tableToIPC,
    Utf8,
    vectorFromArray,
} from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withPriority, type QueryPriority } from "@/lib/query-priority";
import {
    arrowErrorOf,
    BUSY_MESSAGE,
    isBusyMessage,
    jsonErrorOf,
    onModelRecovered,
    parseRetryAfter,
    QueryScheduler,
    recoveriesOf,
    scheduledProxy,
    throttledReply,
    throttleOf,
} from "@/lib/query-scheduler";
import realErrorTable from "@/lib/__fixtures__/power-bi-error-table.json";

function apiError(status: number, body = "", message = `HTTP ${status}`) {
    return new FabricApiProxyError({ status, requestId: "r", sessionId: "s", body, message });
}

/** A task that resolves only when the test says so. */
function deferred<T = string>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * An error table as Power BI sends one in an HTTP 200: the error columns
 * first, the fault in the schema's metadata, LZ4-compressed.
 */
function errorTable(code: string, message: string): ArrayBuffer {
    const schema = new Schema(
        [
            new Field("ErrorCode", new Utf8()),
            new Field("ErrorMessage", new Utf8()),
            new Field("ErrorDescription", new Utf8()),
            new Field("ErrorType", new Int64()),
            new Field("IsPrimaryErrorCode", new Bool()),
        ],
        new Map([
            ["IsError", "true"],
            ["FaultString", message],
        ]),
    );
    const columns = new Table({
        ErrorCode: vectorFromArray([code], new Utf8()),
        ErrorMessage: vectorFromArray([message], new Utf8()),
        ErrorDescription: vectorFromArray([message], new Utf8()),
        ErrorType: vectorFromArray([1n], new Int64()),
        IsPrimaryErrorCode: vectorFromArray([true], new Bool()),
    });
    const table = new Table(schema, columns.batches.map((batch) => new RecordBatch(schema, batch.data)));
    const bytes = new RecordBatchStreamWriter({ compressionType: CompressionType.LZ4_FRAME }).writeAll(table).toUint8Array(true);
    return bytes.slice().buffer;
}

const THROTTLED = "Too many requests were sent to this model. Try again later.";

function answerTable(value = 1): ArrayBuffer {
    return tableToIPC(tableFromArrays({ Value: Int32Array.of(value) }), "stream").slice().buffer;
}

function fromBase64(text: string): ArrayBuffer {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0)).buffer;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("parseRetryAfter", () => {
    it("reads seconds", () => {
        expect(parseRetryAfter("7")).toBe(7000);
        expect(parseRetryAfter(" 1.5 ")).toBe(1500);
    });

    it("reads an HTTP date as the time left until it", () => {
        const now = Date.parse("2026-07-01T10:00:00Z");
        expect(parseRetryAfter("Wed, 01 Jul 2026 10:00:30 GMT", now)).toBe(30_000);
        expect(parseRetryAfter("Wed, 01 Jul 2026 09:59:00 GMT", now)).toBe(0);
    });

    it("ignores what it can't read", () => {
        expect(parseRetryAfter(undefined)).toBeUndefined();
        expect(parseRetryAfter(null)).toBeUndefined();
        expect(parseRetryAfter("soon")).toBeUndefined();
    });
});

describe("throttleOf", () => {
    it("treats 429 and 503 as throttling, and nothing else", () => {
        expect(throttleOf(apiError(429))).toEqual({ status: 429, retryAfterMs: undefined });
        expect(throttleOf(apiError(503))).toEqual({ status: 503, retryAfterMs: undefined });
        expect(throttleOf(apiError(400))).toBeUndefined();
        expect(throttleOf(apiError(500))).toBeUndefined();
        expect(throttleOf(new TypeError("offline"))).toBeUndefined();
    });

    it("reads Retry-After carried on the error, or written in its body", () => {
        const carried = Object.assign(apiError(429), { retryAfterMs: 4000 });
        expect(throttleOf(carried)?.retryAfterMs).toBe(4000);
        expect(throttleOf(apiError(429, '{"retryAfter": 12}'))?.retryAfterMs).toBe(12_000);
    });

    it("spots the host's rate limit when it carries no status", () => {
        const limited = new FabricGenericProxyError({ message: "Request failed", cause: { code: "RATE_LIMITED" } });
        expect(throttleOf(limited)?.status).toBe(429);
        expect(throttleOf(new Error("Too many requests"))?.status).toBe(429);
    });

    it("spots a rate limit by what it says, whatever its status, and keeps a printable code", () => {
        expect(throttleOf(apiError(400, "", "Rate limit exceeded"))?.status).toBe(429);
        expect(throttleOf(Object.assign(apiError(429), { errorCode: "3238002688" }))?.code).toBe("3238002688");
        expect(throttleOf(Object.assign(apiError(429), { errorCode: "<b>not a code</b>" }))?.code).toBeUndefined();
    });

    it("doesn't take a name a query error quotes, or the error itself, for a throttle", () => {
        expect(throttleOf(apiError(400, "", "Query (5, 59) Cannot find table '<oii>Rate Limit</oii>'."))).toBeUndefined();
        expect(throttleOf(apiError(400, "", "Cannot find table 'Throttle Log'."))).toBeUndefined();
        expect(throttleOf(new Error("The column 'Usage'[Rate Limit] cannot be found"))).toBeUndefined();
        expect(throttleOf(new Error("Query (1, 8) The function RATELIMIT doesn't exist."))).toBeUndefined();
        expect(throttleOf(new Error("You've hit the rate limit; we're throttling"))?.status).toBe(429);
    });
});

describe("reading a throttle sent in an HTTP 200", () => {
    it("reads Power BI's error table, compressed as it sends it", () => {
        const found = arrowErrorOf(errorTable("3238002688", THROTTLED));
        expect(found).toEqual({ code: "3238002688", message: THROTTLED });
        expect(throttledReply(found, "req")).toMatchObject({ status: 429, requestId: "req", message: THROTTLED, errorCode: "3238002688" });
    });

    it("reads a real error table, and leaves a real query error alone", () => {
        const found = arrowErrorOf(fromBase64(realErrorTable.base64));
        expect(found?.code).toBe("3241803779");
        expect(found?.message).toMatch(/^Query \(5, 59\) Cannot find table/);
        expect(throttledReply(found, "req")).toBeUndefined();
    });

    it("leaves answers, empty replies and what it can't read to the SDK", () => {
        expect(arrowErrorOf(answerTable())).toBeUndefined();
        expect(arrowErrorOf(new ArrayBuffer(0))).toBeUndefined();
        expect(arrowErrorOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeUndefined();
        expect(arrowErrorOf(new ArrayBuffer(64 * 1024 + 1))).toBeUndefined();
        expect(arrowErrorOf(undefined)).toBeUndefined();
    });

    it("reads a JSON error where the SDK does", () => {
        expect(jsonErrorOf({ error: { code: "TooManyRequests", message: THROTTLED } })).toEqual({ code: "TooManyRequests", message: THROTTLED });
        expect(jsonErrorOf({ results: [{ error: { message: THROTTLED } }] })).toEqual({ code: "", message: THROTTLED });
        expect(jsonErrorOf({ results: [{ tables: [{ error: { code: "Throttled" } }] }] })).toEqual({ code: "Throttled", message: "" });
        expect(jsonErrorOf({ results: [{ tables: [{ rows: [{ "[Value]": 1 }] }] }] })).toBeUndefined();
        expect(jsonErrorOf(null)).toBeUndefined();
        expect(throttledReply({ code: "Throttled", message: "" }, "req")).toMatchObject({ status: 429, message: "Throttled" });
        expect(throttledReply({ code: "DAX", message: "The column 'X'[Y] cannot be found" }, "req")).toBeUndefined();
    });
});

describe("isBusyMessage", () => {
    it("matches the busy message and Power BI's throttling text", () => {
        expect(isBusyMessage(BUSY_MESSAGE)).toBe(true);
        expect(isBusyMessage("Too many requests")).toBe(true);
        expect(isBusyMessage("The dates with Copilot activity couldn't be read: Power BI is busy: …")).toBe(true);
        expect(isBusyMessage("The column 'X'[Y] cannot be found")).toBe(false);
        expect(isBusyMessage(undefined)).toBe(false);
    });

    it("doesn't show the busy card for a query error that names a rate limit", () => {
        expect(isBusyMessage("Query (5, 59) Cannot find table '<oii>Rate Limit</oii>'.")).toBe(false);
        expect(isBusyMessage("The licences couldn't be read: Cannot find table 'Throttle Log'.")).toBe(false);
        expect(isBusyMessage("You've hit the rate limit; we're throttling")).toBe(true);
        expect(isBusyMessage('{"errors":["Too many requests"]}')).toBe(true);
    });

    it("doesn't show the busy card for a query error that quotes the busy wording", () => {
        expect(isBusyMessage("Query (5, 59) Cannot find table '<oii>Power BI is busy</oii>'.")).toBe(false);
        expect(isBusyMessage(`Cannot find table '${BUSY_MESSAGE.replace(/'/g, "")}'.`)).toBe(false);
        expect(isBusyMessage("The column [Power BI is busy] cannot be found")).toBe(false);
        expect(isBusyMessage(`The licences couldn't be read: ${BUSY_MESSAGE}`)).toBe(true);
    });
});

describe("QueryScheduler", () => {
    it("holds no more than four queries in flight", async () => {
        const scheduler = new QueryScheduler();
        const tasks = Array.from({ length: 10 }, () => deferred());
        let running = 0;
        let peak = 0;
        const results = tasks.map((task, index) =>
            scheduler.run(`q${index}`, async () => {
                running++;
                peak = Math.max(peak, running);
                try {
                    return await task.promise;
                } finally {
                    running--;
                }
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(running).toBe(4);
        for (const [index, task] of tasks.entries()) {
            task.resolve(`a${index}`);
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(await Promise.all(results)).toEqual(tasks.map((_, index) => `a${index}`));
        expect(peak).toBe(4);
    });

    it("starts no more than 90 queries in a minute", async () => {
        const scheduler = new QueryScheduler({ concurrency: 1000 });
        const started: number[] = [];
        const results = Array.from({ length: 100 }, (_, index) =>
            scheduler.run(`q${index}`, async () => {
                started.push(Date.now());
                return index;
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toHaveLength(90);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(started).toHaveLength(90);
        await vi.advanceTimersByTimeAsync(1);
        expect(started).toHaveLength(100);
        await Promise.all(results);
    });

    it("retries a throttled query with backoff, then succeeds", async () => {
        const scheduler = new QueryScheduler({ random: () => 1 });
        const task = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce("ok");
        const result = scheduler.run("q", task);
        await vi.advanceTimersByTimeAsync(0);
        expect(task).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(task).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(task).toHaveBeenCalledTimes(2);
        await expect(result).resolves.toBe("ok");
    });

    it("doubles the backoff with each retry, jittered", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const calls: number[] = [];
        const task = vi.fn(async () => {
            calls.push(Date.now());
            if (calls.length < 3) throw apiError(503);
            return "ok";
        });
        const result = scheduler.run("q", task);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(result).resolves.toBe("ok");
        // Half the backoff with no jitter: 500 ms, then 1000 ms.
        expect(calls.map((time) => time - calls[0])).toEqual([0, 500, 1500]);
    });

    it("waits as long as Retry-After asks, and holds every other query to the model meanwhile", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const throttled = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(apiError(429), { retryAfterMs: 5000 }))
            .mockResolvedValueOnce("first");
        const first = scheduler.run("a", throttled);
        await vi.advanceTimersByTimeAsync(0);

        const other = vi.fn().mockResolvedValue("second");
        const second = scheduler.run("b", other);
        await vi.advanceTimersByTimeAsync(4999);
        expect(throttled).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(first).resolves.toBe("first");
        await expect(second).resolves.toBe("second");
    });

    it("gives up with the busy message once a query has waited a minute on its model", async () => {
        const scheduler = new QueryScheduler({ random: () => 1 });
        const calls: number[] = [];
        const task = vi.fn(async () => {
            calls.push(Date.now());
            throw apiError(429, "Too many requests");
        });
        const result = scheduler.run("q", task);
        const settled = expect(result).rejects.toMatchObject({ status: 429, message: BUSY_MESSAGE });
        await vi.advanceTimersByTimeAsync(60_000);
        await settled;
        // Backoffs of 1, 2, 4 and 8 seconds, then never more than 15.
        expect(calls.map((time) => (time - calls[0]) / 1000)).toEqual([0, 1, 3, 7, 15, 30, 45, 60]);
        await expect(result).rejects.toBeInstanceOf(FabricApiProxyError);
    });

    it("pauses only the model that throttled; queries to other models carry on", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const throttled = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(apiError(429), { retryAfterMs: 5000 }))
            .mockResolvedValueOnce("first");
        const first = scheduler.run("a", throttled, "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(0);

        const same = vi.fn(async () => "same");
        const other = vi.fn(async () => "other");
        const sameModel = scheduler.run("b", same, "normal", "ws/vl");
        await expect(scheduler.run("c", other, "normal", "ws/cc")).resolves.toBe("other");
        expect(same).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5000);
        await expect(first).resolves.toBe("first");
        await expect(sameModel).resolves.toBe("same");
    });

    it("tries a throttled model with one query at a time until it answers", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const gates = [deferred(), deferred(), deferred()];
        const tasks = gates.map((gate) => vi.fn(() => gate.promise));
        tasks[0].mockRejectedValueOnce(apiError(429));
        const first = scheduler.run("a", tasks[0]);
        await vi.advanceTimersByTimeAsync(0);
        const rest = [scheduler.run("b", tasks[1]), scheduler.run("c", tasks[2])];
        const sent = () => tasks.reduce((sum, task) => sum + task.mock.calls.length, 0) - 1;

        await vi.advanceTimersByTimeAsync(499);
        expect(sent()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(sent()).toBe(1);

        for (const [index, gate] of gates.entries()) gate.resolve(`answer${index}`);
        await expect(Promise.all([first, ...rest])).resolves.toEqual(["answer0", "answer1", "answer2"]);
        expect(sent()).toBe(3);
    });

    it("says in the console what it does about a throttle", async () => {
        const log = vi.fn();
        const scheduler = new QueryScheduler({ random: () => 0, log });
        const task = vi.fn().mockRejectedValueOnce(Object.assign(apiError(429), { errorCode: "3238002688" })).mockResolvedValueOnce("ok");
        const result = scheduler.run("q", task, "normal", "ws/bde54d4a-2321-41e4-83aa-7a2b5a830457");
        await vi.advanceTimersByTimeAsync(500);
        await expect(result).resolves.toBe("ok");
        expect(log.mock.calls).toEqual([
            [
                "warn",
                "Fabric app: Power BI throttled a query to model bde54d4a (HTTP 429, 3238002688), 1 in a row. Its queries wait 0.5 s, then try it one at a time.",
            ],
            ["info", "Fabric app: background loading from model bde54d4a paused for at least 60 s, and until it answers a query on screen."],
            ["info", "Fabric app: model bde54d4a is answering again."],
        ]);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(log).toHaveBeenLastCalledWith("info", "Fabric app: background loading from model bde54d4a resumed.");
    });

    it("says HTTP 200 for a throttle Power BI sent as an error table", async () => {
        const log = vi.fn();
        const scheduler = new QueryScheduler({ random: () => 0, log });
        const task = vi.fn().mockRejectedValueOnce(throttledReply({ code: "3238002688", message: THROTTLED }, "r")).mockResolvedValueOnce("ok");
        const result = scheduler.run("q", task, "normal", "ws/bde54d4a");
        await vi.advanceTimersByTimeAsync(500);
        await expect(result).resolves.toBe("ok");
        expect(log.mock.calls[0]).toEqual([
            "warn",
            "Fabric app: Power BI throttled a query to model bde54d4a (HTTP 200, 3238002688), 1 in a row. Its queries wait 0.5 s, then try it one at a time.",
        ]);
    });

    it("says once when a model that left a card busy answers again, naming only that model", async () => {
        const log = vi.fn();
        const scheduler = new QueryScheduler({ random: () => 0, log });
        const recovered = vi.fn();
        onTestFinished(onModelRecovered(recovered));
        let throttling = true;
        const task = vi.fn(async () => {
            if (throttling) throw apiError(429);
            return "ok";
        });
        const busy = scheduler.run("a", task, "normal", "ws/bde54d4a");
        const settled = expect(busy).rejects.toMatchObject({ message: BUSY_MESSAGE });
        await expect(scheduler.run("c", async () => "other", "normal", "ws/648411c2")).resolves.toBe("other");
        await vi.advanceTimersByTimeAsync(60_000);
        await settled;
        expect(recovered).not.toHaveBeenCalled();

        throttling = false;
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(scheduler.run("b", task, "normal", "ws/bde54d4a")).resolves.toBe("ok");
        expect(recovered.mock.calls).toEqual([["ws/bde54d4a"]]);
        expect(log).toHaveBeenCalledWith("info", 'Fabric app: cards that showed "Power BI is busy" ask model bde54d4a again.');

        await expect(scheduler.run("d", task, "normal", "ws/bde54d4a")).resolves.toBe("ok");
        expect(recovered).toHaveBeenCalledTimes(1);
    });

    it("says a model answers again once the pause it asked for ends, not before", async () => {
        const scheduler = new QueryScheduler({ random: () => 0, log: () => {} });
        const recovered = vi.fn();
        onTestFinished(onModelRecovered(recovered));
        const sentBefore = deferred();
        const early = scheduler.run("early", () => sentBefore.promise, "normal", "ws/vl");
        const throttled = vi.fn().mockRejectedValue(Object.assign(apiError(429), { retryAfterMs: 120_000 }));
        await expect(scheduler.run("a", throttled, "normal", "ws/vl")).rejects.toMatchObject({ message: BUSY_MESSAGE });
        sentBefore.resolve("early");
        await expect(early).resolves.toBe("early");
        await vi.advanceTimersByTimeAsync(119_999);
        expect(recovered).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(recovered.mock.calls).toEqual([["ws/vl"]]);
        await expect(scheduler.run("b", async () => "ok", "normal", "ws/vl")).resolves.toBe("ok");
        expect(recovered).toHaveBeenCalledTimes(1);
    });

    it("doesn't say a model answers again when it throttles once more before its pause ends", async () => {
        const scheduler = new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} });
        const recovered = vi.fn();
        onTestFinished(onModelRecovered(recovered));
        const sentBefore = deferred();
        const alsoBefore = deferred();
        const early = scheduler.run("early", () => sentBefore.promise, "normal", "ws/vl");
        const late = scheduler.run("late", () => alsoBefore.promise, "normal", "ws/vl");
        const throttled = vi.fn().mockRejectedValue(Object.assign(apiError(429), { retryAfterMs: 120_000 }));
        await expect(scheduler.run("a", throttled, "normal", "ws/vl")).rejects.toMatchObject({ message: BUSY_MESSAGE });
        sentBefore.resolve("early");
        await expect(early).resolves.toBe("early");
        alsoBefore.reject(apiError(429));
        await expect(late).rejects.toMatchObject({ message: BUSY_MESSAGE });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(recovered).not.toHaveBeenCalled();

        await expect(scheduler.run("b", async () => "ok", "normal", "ws/vl")).resolves.toBe("ok");
        expect(recovered.mock.calls).toEqual([["ws/vl"]]);
    });

    it("dates a busy answer by the recoveries its model had when the query began to wait, for every caller sharing it", async () => {
        const scheduler = new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} });
        await expect(scheduler.run("seed", vi.fn().mockRejectedValue(apiError(429)), "normal", "ws/dated")).rejects.toThrow(BUSY_MESSAGE);
        const before = recoveriesOf("ws/dated");
        const probe = deferred();
        const probing = scheduler.run("probe", () => probe.promise, "normal", "ws/dated");
        const waiting = scheduler.run("q", async () => "q", "normal", "ws/dated");
        const settled = expect(waiting).rejects.toMatchObject({ message: BUSY_MESSAGE, recoveries: before });
        await vi.advanceTimersByTimeAsync(30_000);
        const joined = scheduler.run("q", async () => "q", "normal", "ws/dated");
        const joinedSettled = expect(joined).rejects.toMatchObject({ message: BUSY_MESSAGE, recoveries: before });
        await vi.advanceTimersByTimeAsync(30_000);

        // The model answers after the wait ran out: the busy answer predates it, whoever holds it.
        probe.resolve("probe");
        await expect(probing).resolves.toBe("probe");
        await settled;
        await joinedSettled;
        expect(recoveriesOf("ws/dated")).toBe(before + 1);
    });

    it("dates a busy answer by the recoveries its model had when the query was sent", async () => {
        const scheduler = new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} });
        await expect(scheduler.run("seed", vi.fn().mockRejectedValue(apiError(429)), "normal", "ws/sent")).rejects.toThrow(BUSY_MESSAGE);
        const probe = deferred();
        const probing = scheduler.run("probe", () => probe.promise, "normal", "ws/sent");
        const waiting = scheduler.run("q", vi.fn().mockRejectedValue(apiError(429)), "normal", "ws/sent");
        const before = recoveriesOf("ws/sent");
        const settled = expect(waiting).rejects.toMatchObject({ message: BUSY_MESSAGE, recoveries: before + 1 });
        await vi.advanceTimersByTimeAsync(1_000);

        // It waited through the recovery, then was throttled once sent: its busy answer is current.
        probe.resolve("probe");
        await expect(probing).resolves.toBe("probe");
        await settled;
        expect(recoveriesOf("ws/sent")).toBe(before + 1);
    });

    it("sends a background query asked for on screen long after its model's throttle: its wait counts from then", async () => {
        const log = vi.fn();
        const scheduler = new QueryScheduler({ random: () => 0, log });
        const back = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("back");
        const background = scheduler.run("back", back, "low", "ws/vl");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(back).toHaveBeenCalledTimes(1);

        // Another card on screen tries the model first, and is still waiting for its answer.
        const probe = deferred();
        const first = scheduler.run("first", () => probe.promise, "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(0);
        const asked = scheduler.run("back", back, "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(back).toHaveBeenCalledTimes(1);

        probe.resolve("first");
        await expect(first).resolves.toBe("first");
        await expect(asked).resolves.toBe("back");
        expect(background).toBe(asked);
        expect(back).toHaveBeenCalledTimes(2);
        expect(log.mock.calls.some(([, message]) => String(message).includes("still throttling"))).toBe(false);
    });

    it("gives up at once when Retry-After asks for longer than a minute", async () => {
        const scheduler = new QueryScheduler();
        const task = vi.fn().mockRejectedValue(Object.assign(apiError(429), { retryAfterMs: 120_000 }));
        await expect(scheduler.run("q", task)).rejects.toMatchObject({ message: BUSY_MESSAGE });
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("keeps all of a long Retry-After: nothing goes to the model before it ends", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const sent: Array<[string, number]> = [];
        const start = Date.now();
        const task = (name: string, retryAfterMs?: number) => async () => {
            sent.push([name, Date.now() - start]);
            if (retryAfterMs) throw Object.assign(apiError(429), { retryAfterMs });
            return name;
        };
        await expect(scheduler.run("a", task("a", 120_000), "normal", "ws/vl")).rejects.toMatchObject({ message: BUSY_MESSAGE });
        // It can't wait two minutes, so it gives up now rather than ask the model early.
        await expect(scheduler.run("b", task("b"), "normal", "ws/vl")).rejects.toMatchObject({ message: BUSY_MESSAGE });
        await expect(scheduler.run("c", task("c"), "normal", "ws/cc")).resolves.toBe("c");

        await vi.advanceTimersByTimeAsync(60_000);
        const late = scheduler.run("d", task("d"), "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(59_999);
        expect(sent.map(([name]) => name)).toEqual(["a", "c"]);
        await vi.advanceTimersByTimeAsync(1);
        await expect(late).resolves.toBe("d");
        expect(sent).toEqual([
            ["a", 0],
            ["c", 0],
            ["d", 120_000],
        ]);
    });

    it("keeps the longest Retry-After from replies to queries already sent", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const gate = deferred();
        const short = vi.fn().mockRejectedValueOnce(Object.assign(apiError(429), { retryAfterMs: 1000 })).mockResolvedValue("short");
        const long = vi.fn(async () => {
            await gate.promise;
            throw Object.assign(apiError(429), { retryAfterMs: 120_000 });
        });
        const first = scheduler.run("a", short, "normal", "ws/vl");
        const second = scheduler.run("b", long, "normal", "ws/vl");
        const settled = Promise.all([
            expect(first).rejects.toMatchObject({ message: BUSY_MESSAGE }),
            expect(second).rejects.toMatchObject({ message: BUSY_MESSAGE }),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        gate.resolve("");
        await vi.advanceTimersByTimeAsync(0);
        await settled;
        expect(short).toHaveBeenCalledTimes(1);
        expect(long).toHaveBeenCalledTimes(1);
    });

    it("doesn't retry a query error whose message names a rate limit", async () => {
        const scheduler = new QueryScheduler({ maxRetries: 2 });
        const bad = apiError(400, "", "Query (5, 59) Cannot find table '<oii>Rate Limit</oii>'.");
        const task = vi.fn().mockRejectedValue(bad);
        await expect(scheduler.run("q", task)).rejects.toBe(bad);
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("doesn't retry errors that aren't throttling", async () => {
        const scheduler = new QueryScheduler();
        const bad = apiError(400, "", "The column 'X'[Y] cannot be found");
        const task = vi.fn().mockRejectedValue(bad);
        await expect(scheduler.run("q", task)).rejects.toBe(bad);
        expect(task).toHaveBeenCalledTimes(1);

        const broken = vi.fn().mockRejectedValue(apiError(500));
        await expect(scheduler.run("r", broken)).rejects.toMatchObject({ status: 500 });
        expect(broken).toHaveBeenCalledTimes(1);
    });

    it("shares one request between identical queries in flight", async () => {
        const scheduler = new QueryScheduler();
        const gate = deferred();
        const task = vi.fn(() => gate.promise);
        const first = scheduler.run("same", task);
        const second = scheduler.run("same", task);
        expect(second).toBe(first);
        gate.resolve("answer");
        await expect(first).resolves.toBe("answer");
        expect(task).toHaveBeenCalledTimes(1);

        // Once settled, the key asks again.
        await expect(scheduler.run("same", async () => "fresh")).resolves.toBe("fresh");
    });

    it("lets a failed query be asked again", async () => {
        const scheduler = new QueryScheduler();
        await expect(scheduler.run("q", () => Promise.reject(apiError(400)))).rejects.toMatchObject({ status: 400 });
        await expect(scheduler.run("q", async () => "ok")).resolves.toBe("ok");
    });
});

describe("QueryScheduler background lane", () => {
    it("waits until nothing on screen is running or waiting", async () => {
        const scheduler = new QueryScheduler();
        const front = deferred();
        const back = vi.fn(async () => "back");
        const foreground = scheduler.run("front", () => front.promise);
        const background = scheduler.run("back", back, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(back).not.toHaveBeenCalled();
        expect(scheduler.activity()).toEqual({ foreground: 1, background: 1, finished: 0 });

        front.resolve("front");
        await expect(foreground).resolves.toBe("front");
        await expect(background).resolves.toBe("back");
        expect(scheduler.activity()).toEqual({ foreground: 0, background: 0, finished: 2 });
    });

    it("runs one at a time in a slot of its own, so the page on screen keeps all four", async () => {
        const scheduler = new QueryScheduler();
        const slow = deferred();
        let backRunning = 0;
        let backPeak = 0;
        const backs = [0, 1].map((index) =>
            scheduler.run(
                `back${index}`,
                async () => {
                    backRunning++;
                    backPeak = Math.max(backPeak, backRunning);
                    try {
                        return await slow.promise;
                    } finally {
                        backRunning--;
                    }
                },
                "low",
            ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(backRunning).toBe(1);

        const gates = Array.from({ length: 4 }, () => deferred());
        let frontRunning = 0;
        const fronts = gates.map((gate, index) =>
            scheduler.run(`front${index}`, async () => {
                frontRunning++;
                try {
                    return await gate.promise;
                } finally {
                    frontRunning--;
                }
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(frontRunning).toBe(4);

        // The first background query finishes; the second waits for the page on screen.
        slow.resolve("slow");
        await vi.advanceTimersByTimeAsync(0);
        expect(backRunning).toBe(0);
        expect(scheduler.activity()).toMatchObject({ foreground: 4, background: 1 });

        for (const gate of gates) gate.resolve("front");
        await Promise.all(fronts);
        await Promise.all(backs);
        expect(backPeak).toBe(1);
    });

    it("moves a background query to the front when someone opens what it fetches", async () => {
        const scheduler = new QueryScheduler();
        const front = deferred();
        const busy = scheduler.run("front", () => front.promise);
        const task = vi.fn(async () => "answer");
        const background = scheduler.run("q", task, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(task).not.toHaveBeenCalled();

        const joined = scheduler.run("q", task);
        expect(joined).toBe(background);
        await expect(joined).resolves.toBe("answer");
        expect(task).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 0 });

        front.resolve("front");
        await busy;
    });

    it("starts at most half the per-minute budget, leaving the rest for the page on screen", async () => {
        const scheduler = new QueryScheduler({ perMinute: 10, lowConcurrency: 100 });
        const started: number[] = [];
        const backs = Array.from({ length: 6 }, (_, index) =>
            scheduler.run(
                `back${index}`,
                async () => {
                    started.push(index);
                    return index;
                },
                "low",
            ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toHaveLength(5);
        await expect(scheduler.run("front", async () => "front")).resolves.toBe("front");

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started).toHaveLength(6);
        await Promise.all(backs);
    });

    it("moves a background query waiting on its budget to the front lane, which has budget to spare", async () => {
        const scheduler = new QueryScheduler({ perMinute: 10 });
        for (let index = 0; index < 5; index++) await scheduler.run(`seed${index}`, async () => index);
        const task = vi.fn(async () => "answer");
        const background = scheduler.run("q", task, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(task).not.toHaveBeenCalled();

        const asked = scheduler.run("q", task);
        await vi.advanceTimersByTimeAsync(0);
        expect(task).toHaveBeenCalledTimes(1);
        await expect(asked).resolves.toBe("answer");
        await expect(background).resolves.toBe("answer");
        expect(Date.now()).toBe(new Date("2026-07-01T10:00:00Z").getTime());
    });

    it("checks the screen is still quiet when a background query wakes from its budget wait", async () => {
        const scheduler = new QueryScheduler({ perMinute: 10 });
        for (let index = 0; index < 5; index++) await scheduler.run(`seed${index}`, async () => index);
        const back = vi.fn(async () => "back");
        const background = scheduler.run("back", back, "low");
        await vi.advanceTimersByTimeAsync(0);
        const front = deferred();
        const foreground = scheduler.run("front", () => front.promise);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(back).not.toHaveBeenCalled();
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });

        front.resolve("front");
        await expect(foreground).resolves.toBe("front");
        await expect(background).resolves.toBe("back");
    });

    it("keeps a throttled background query out of the way until its model's hold ends", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const back = vi.fn(async () => {
            if (back.mock.calls.length === 1) throw apiError(429);
            return "back";
        });
        const background = scheduler.run("back", back, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(back).toHaveBeenCalledTimes(1);
        const front = deferred();
        const foreground = scheduler.run("front", () => front.promise);
        await vi.advanceTimersByTimeAsync(1000);
        expect(back).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });

        front.resolve("front");
        await foreground;
        await vi.advanceTimersByTimeAsync(58_999);
        expect(back).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(background).resolves.toBe("back");
        expect(back).toHaveBeenCalledTimes(2);
    });

    it("holds a throttled model's background queries until one on screen succeeds; other models' carry on", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const vl = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("vl");
        const held = scheduler.run("vl-back", vl, "low", "ws/vl");
        await vi.advanceTimersByTimeAsync(0);
        expect(vl).toHaveBeenCalledTimes(1);

        await expect(scheduler.run("cc-back", async () => "cc", "low", "ws/cc")).resolves.toBe("cc");

        await vi.advanceTimersByTimeAsync(120_000);
        expect(vl).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 1 });

        await expect(scheduler.run("vl-front", async () => "front", "normal", "ws/vl")).resolves.toBe("front");
        await expect(held).resolves.toBe("vl");
        expect(vl).toHaveBeenCalledTimes(2);
    });

    it("lets someone on screen ask for a held background query at once", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const vl = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("vl");
        const held = scheduler.run("vl-back", vl, "low", "ws/vl");
        await vi.advanceTimersByTimeAsync(1000);
        expect(vl).toHaveBeenCalledTimes(1);

        const asked = scheduler.run("vl-back", vl, "normal", "ws/vl");
        expect(asked).toBe(held);
        await vi.advanceTimersByTimeAsync(0);
        await expect(asked).resolves.toBe("vl");
        expect(vl).toHaveBeenCalledTimes(2);
    });

    it("lets background queries try a held model again five minutes after its last throttle, though nothing on screen asked it", async () => {
        const log = vi.fn();
        const scheduler = new QueryScheduler({ random: () => 0, log });
        const vl = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("vl");
        const held = scheduler.run("vl-back", vl, "low", "ws/vl");
        await vi.advanceTimersByTimeAsync(299_999);
        expect(vl).toHaveBeenCalledTimes(1);
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 1 });

        await vi.advanceTimersByTimeAsync(1);
        await expect(held).resolves.toBe("vl");
        expect(vl).toHaveBeenCalledTimes(2);
        expect(log.mock.calls).toEqual([
            ["warn", "Fabric app: Power BI throttled a query to model vl (HTTP 429), 1 in a row. Its queries wait 0.5 s, then try it one at a time."],
            ["info", "Fabric app: background loading from model vl paused for at least 60 s, and until it answers a query on screen."],
            ["info", "Fabric app: background loading from model vl resumed 300 s after its last throttle, without an answer on screen."],
            ["info", "Fabric app: model vl is answering again."],
        ]);
    });

    it("counts the five minutes from the model's last throttle, so a model still throttling queries on screen stays held", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const back = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("back");
        const held = scheduler.run("back", back, "low", "ws/later");
        await vi.advanceTimersByTimeAsync(200_000);
        const front = vi.fn().mockRejectedValue(Object.assign(apiError(429), { retryAfterMs: 120_000 }));
        await expect(scheduler.run("front", front, "normal", "ws/later")).rejects.toMatchObject({ message: BUSY_MESSAGE });

        await vi.advanceTimersByTimeAsync(299_999);
        expect(back).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(held).resolves.toBe("back");
        expect(back).toHaveBeenCalledTimes(2);
    });

    it("lets one background query try the model after five minutes, and holds the rest five minutes more if it is throttled", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const first = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("first");
        const second = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("second");
        const backs = [scheduler.run("first", first, "low", "ws/vl"), scheduler.run("second", second, "low", "ws/vl")];
        await vi.advanceTimersByTimeAsync(299_999);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();

        // The second is first in line, so it alone tries the model, and is throttled.
        await vi.advanceTimersByTimeAsync(1);
        expect(second).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(299_999);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(Promise.all(backs)).resolves.toEqual(["first", "second"]);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it("tells subscribers when work starts and finishes", async () => {
        const scheduler = new QueryScheduler();
        const listener = vi.fn();
        const stop = scheduler.subscribe(listener);
        await scheduler.run("q", async () => 1);
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
        await scheduler.run("r", async () => 1);
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe("QueryScheduler when a card goes", () => {
    const gone = { name: "AbortError" };

    it("stops a throttled query nobody waits for: nothing more is sent, and the model's pause stands", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const task = vi.fn().mockRejectedValue(apiError(429));
        const card = new AbortController();
        const result = scheduler.run("q", task, "normal", "ws/vl", card.signal);
        const settled = expect(result).rejects.toMatchObject(gone);
        await vi.advanceTimersByTimeAsync(0);
        expect(task).toHaveBeenCalledTimes(1);

        card.abort();
        await settled;
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 0 });
        expect(throttleOf(await result.catch((error: unknown) => error))).toBeUndefined();

        const next = vi.fn(async () => "next");
        const asked = scheduler.run("r", next, "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(499);
        expect(next).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(asked).resolves.toBe("next");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(task).toHaveBeenCalledTimes(1);
    });

    it("carries on for a card still waiting on the same query", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const task = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("ok");
        const [one, two] = [new AbortController(), new AbortController()];
        const first = scheduler.run("q", task, "normal", "", one.signal);
        const second = scheduler.run("q", task, "normal", "", two.signal);
        await vi.advanceTimersByTimeAsync(0);
        one.abort();
        await vi.advanceTimersByTimeAsync(500);
        await expect(second).resolves.toBe("ok");
        await expect(first).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(2);
    });

    it("runs to the end for a caller that can't say it has gone", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const task = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue("ok");
        const card = new AbortController();
        const kept = scheduler.run("q", task);
        scheduler.run("q", task, "normal", "", card.signal);
        await vi.advanceTimersByTimeAsync(0);
        card.abort();
        await vi.advanceTimersByTimeAsync(500);
        await expect(kept).resolves.toBe("ok");
        expect(task).toHaveBeenCalledTimes(2);
    });

    it("lets a query already sent finish and keeps its answer, but doesn't retry its throttle", async () => {
        const scheduler = new QueryScheduler({ random: () => 0 });
        const answer = deferred();
        const card = new AbortController();
        const answered = scheduler.run("a", () => answer.promise, "normal", "", card.signal);
        await vi.advanceTimersByTimeAsync(0);
        card.abort();
        expect(scheduler.activity()).toMatchObject({ foreground: 1 });
        answer.resolve("answer");
        await expect(answered).resolves.toBe("answer");

        const reply = deferred();
        const throttled = vi.fn(() => reply.promise);
        const other = new AbortController();
        const result = scheduler.run("b", throttled, "normal", "ws/vl", other.signal);
        const settled = expect(result).rejects.toMatchObject(gone);
        await vi.advanceTimersByTimeAsync(0);
        other.abort();
        reply.reject(apiError(429));
        await settled;
        const next = vi.fn(async () => "next");
        const asked = scheduler.run("c", next, "normal", "ws/vl");
        await vi.advanceTimersByTimeAsync(499);
        expect(next).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(asked).resolves.toBe("next");
        expect(throttled).toHaveBeenCalledTimes(1);
    });

    it("gives a queued query's place to the next in line, and sends it afresh if asked again", async () => {
        const scheduler = new QueryScheduler({ concurrency: 1 });
        const gate = deferred();
        const running = scheduler.run("a", () => gate.promise);
        const dropped = vi.fn(async () => "b");
        const card = new AbortController();
        const queued = scheduler.run("b", dropped, "normal", "", card.signal);
        const next = vi.fn(async () => "c");
        const waiting = scheduler.run("c", next);
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.activity()).toMatchObject({ foreground: 3 });

        card.abort();
        await expect(queued).rejects.toMatchObject(gone);
        expect(scheduler.activity()).toMatchObject({ foreground: 2 });
        gate.resolve("a");
        await expect(Promise.all([running, waiting])).resolves.toEqual(["a", "c"]);
        expect(dropped).not.toHaveBeenCalled();

        await expect(scheduler.run("b", dropped)).resolves.toBe("b");
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 0 });
    });

    it("drops a background query when its hidden page goes, so the next can start", async () => {
        const scheduler = new QueryScheduler();
        const front = deferred();
        const foreground = scheduler.run("front", () => front.promise);
        const page = new AbortController();
        const dropped = vi.fn(async () => "dropped");
        const background = scheduler.run("back", dropped, "low", "", page.signal);
        const settled = expect(background).rejects.toMatchObject(gone);
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });

        page.abort();
        await settled;
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 0 });
        const later = scheduler.run("later", async () => "later", "low");
        front.resolve("front");
        await foreground;
        await expect(later).resolves.toBe("later");
        expect(dropped).not.toHaveBeenCalled();
    });

    it("refuses at once for a caller that has already gone", async () => {
        const scheduler = new QueryScheduler();
        const task = vi.fn(async () => "never");
        await expect(scheduler.run("q", task, "normal", "", AbortSignal.abort())).rejects.toMatchObject(gone);
        expect(task).not.toHaveBeenCalled();
        expect(scheduler.activity()).toEqual({ foreground: 0, background: 0, finished: 0 });
    });
});

describe("QueryScheduler lead queries", () => {
    /** A scheduler with all four slots on screen taken; `started` lists the queries asked after, in the order they start. */
    function fullScheduler() {
        const scheduler = new QueryScheduler();
        const slots = Array.from({ length: 4 }, () => deferred());
        slots.forEach((slot, index) => scheduler.run(`slot${index}`, () => slot.promise));
        const started: string[] = [];
        const ask = (key: string, lead = false, signal?: AbortSignal, priority: QueryPriority = "normal") =>
            scheduler.run(
                key,
                async () => {
                    started.push(key);
                    return key;
                },
                priority,
                "",
                signal,
                lead,
            );
        const drain = async () => {
            for (const slot of slots) slot.resolve("slot");
            await vi.advanceTimersByTimeAsync(0);
        };
        return { scheduler, started, ask, drain };
    }

    it("lets a lead query in ahead of the queries already waiting", async () => {
        const { started, ask, drain } = fullScheduler();
        const results = [ask("a"), ask("b"), ask("lead", true)];
        await drain();
        await expect(Promise.all(results)).resolves.toEqual(["a", "b", "lead"]);
        expect(started).toEqual(["lead", "a", "b"]);
    });

    it("keeps lead queries first in, first out among themselves, all ahead of the rest", async () => {
        const { started, ask, drain } = fullScheduler();
        const results = [ask("a"), ask("lead1", true), ask("b"), ask("lead2", true)];
        await drain();
        await Promise.all(results);
        expect(started).toEqual(["lead1", "lead2", "a", "b"]);
    });

    it("moves a waiting query up once a lead card asks for it too, and keeps it there", async () => {
        const { started, ask, drain } = fullScheduler();
        const first = ask("a");
        const shared = ask("b");
        expect(ask("b", true)).toBe(shared);
        const results = [first, shared, ask("lead", true), ask("b")];
        await drain();
        await Promise.all(results);
        expect(started).toEqual(["b", "lead", "a"]);
    });

    it("keeps a lead query's place when a lead card asks for it again", async () => {
        const { started, ask, drain } = fullScheduler();
        const results = [ask("lead1", true), ask("lead2", true), ask("a")];
        expect(ask("lead1", true)).toBe(results[0]);
        await drain();
        await Promise.all(results);
        expect(started).toEqual(["lead1", "lead2", "a"]);
    });

    it("lets a background query a lead card asks for on screen in ahead of the queries waiting", async () => {
        const { scheduler, started, ask, drain } = fullScheduler();
        const first = ask("a");
        const background = ask("back", false, undefined, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.activity()).toMatchObject({ background: 1 });

        expect(ask("back", true)).toBe(background);
        expect(scheduler.activity()).toMatchObject({ background: 0 });
        await drain();
        await Promise.all([first, background]);
        expect(started).toEqual(["back", "a"]);
    });

    it("ignores lead in the background: asked for later on screen as any other, the query waits at the back", async () => {
        const { started, ask, drain } = fullScheduler();
        const results = [ask("a"), ask("back", true, undefined, "low")];
        await vi.advanceTimersByTimeAsync(0);
        results.push(ask("back"), ask("lead", true));
        await drain();
        await Promise.all(results);
        expect(started).toEqual(["lead", "a", "back"]);
    });

    it("ignores lead in the background for a query already waiting there too", async () => {
        const { started, ask, drain } = fullScheduler();
        const first = ask("a");
        const background = ask("back", false, undefined, "low");
        await vi.advanceTimersByTimeAsync(0);
        expect(ask("back", true, undefined, "low")).toBe(background);
        expect(ask("back")).toBe(background);
        await drain();
        await Promise.all([first, background]);
        expect(started).toEqual(["a", "back"]);
    });

    it("gives a lead query's place to the next lead once its card has gone", async () => {
        const { started, ask, drain } = fullScheduler();
        const card = new AbortController();
        const first = ask("a");
        const dropped = ask("lead1", true, card.signal);
        const next = ask("lead2", true);
        card.abort();
        await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
        await drain();
        await Promise.all([first, next]);
        expect(started).toEqual(["lead2", "a"]);
    });

    it("keeps a lead query's place when it waits again after a throttle", async () => {
        const scheduler = new QueryScheduler({ concurrency: 1, random: () => 0 });
        const started: string[] = [];
        const gate = deferred();
        const lead = vi
            .fn()
            .mockImplementationOnce(async () => {
                started.push("lead");
                throw apiError(429);
            })
            .mockImplementation(async () => {
                started.push("lead");
                return "lead";
            });
        const answer = scheduler.run("lead", lead, "normal", "ws/vl", undefined, true);
        const other = scheduler.run(
            "cc1",
            async () => {
                started.push("cc1");
                return gate.promise;
            },
            "normal",
            "ws/cc",
        );
        const last = scheduler.run(
            "cc2",
            async () => {
                started.push("cc2");
                return "cc2";
            },
            "normal",
            "ws/cc",
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toEqual(["lead", "cc1"]);

        await vi.advanceTimersByTimeAsync(500);
        gate.resolve("cc1");
        await expect(Promise.all([answer, other, last])).resolves.toEqual(["lead", "cc1", "cc2"]);
        expect(started).toEqual(["lead", "cc1", "lead", "cc2"]);
    });

    it("still holds no more than four queries in flight", async () => {
        const scheduler = new QueryScheduler();
        const tasks = Array.from({ length: 10 }, () => deferred());
        let running = 0;
        let peak = 0;
        const results = tasks.map((task, index) =>
            scheduler.run(
                `q${index}`,
                async () => {
                    running++;
                    peak = Math.max(peak, running);
                    try {
                        return await task.promise;
                    } finally {
                        running--;
                    }
                },
                "normal",
                "",
                undefined,
                index % 2 === 1,
            ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(running).toBe(4);
        for (const task of tasks) {
            task.resolve("a");
            await vi.advanceTimersByTimeAsync(0);
        }
        await Promise.all(results);
        expect(peak).toBe(4);
    });

    it("still starts no more than 90 queries in a minute", async () => {
        const scheduler = new QueryScheduler();
        let started = 0;
        const results = Array.from({ length: 100 }, (_, index) =>
            scheduler.run(
                `q${index}`,
                async () => {
                    started++;
                    return index;
                },
                "normal",
                "",
                undefined,
                index % 3 === 0,
            ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toBe(90);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(started).toBe(90);
        await vi.advanceTimersByTimeAsync(1);
        expect(started).toBe(100);
        await Promise.all(results);
    });

    it("makes a lead query wait for the per-minute budget like any other", async () => {
        const scheduler = new QueryScheduler();
        let normal = 0;
        const results = Array.from({ length: 90 }, (_, index) =>
            scheduler.run(`q${index}`, async () => {
                normal++;
                return index;
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(normal).toBe(90);

        let started = false;
        const lead = scheduler.run(
            "lead",
            async () => {
                started = true;
                return "lead";
            },
            "normal",
            "",
            undefined,
            true,
        );
        await vi.advanceTimersByTimeAsync(59_999);
        expect(started).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(started).toBe(true);
        await expect(lead).resolves.toBe("lead");
        await Promise.all(results);
    });
});

describe("scheduledProxy", () => {
    function fakeProxy() {
        const executeDax = vi.fn(async () => ({ data: new ArrayBuffer(0), requestId: "r" }));
        const executeDaxJson = vi.fn(async () => ({ data: {}, requestId: "r" }));
        const inner = {
            semanticModel: { executeDax, executeDaxJson },
            lakehouse: { executeSql: vi.fn() },
            warehouse: { executeSql: vi.fn() },
        } as unknown as IFabricApiProxy;
        return { inner, executeDax, executeDaxJson };
    }

    it("sends identical concurrent DAX once, and different DAX separately", async () => {
        const { inner, executeDax, executeDaxJson } = fakeProxy();
        const proxy = scheduledProxy(inner, new QueryScheduler());
        await Promise.all([
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"),
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"),
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE B"),
            proxy.semanticModel.executeDaxJson("ws", "m", "EVALUATE A"),
        ]);
        expect(executeDax).toHaveBeenCalledTimes(2);
        expect(executeDaxJson).toHaveBeenCalledTimes(1);
    });

    it("sends a request started in the background lane there", async () => {
        const { inner, executeDax } = fakeProxy();
        const scheduler = new QueryScheduler();
        const proxy = scheduledProxy(inner, scheduler);
        const result = withPriority("low", () => proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"));
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 1 });
        await result;
        expect(executeDax).toHaveBeenCalledTimes(1);
    });

    it("passes the lakehouse and warehouse through untouched", () => {
        const { inner } = fakeProxy();
        const proxy = scheduledProxy(inner);
        expect(proxy.lakehouse).toBe(inner.lakehouse);
        expect(proxy.warehouse).toBe(inner.warehouse);
    });

    it("tells the card starting a request which model it asks", async () => {
        const { inner, executeDax } = fakeProxy();
        const proxy = scheduledProxy(inner, new QueryScheduler());
        const asking = vi.fn();
        await withPriority("normal", () => proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"), { signal: new AbortController().signal, asking });
        expect(asking.mock.calls).toEqual([["ws/m"]]);
        expect(executeDax).toHaveBeenCalledTimes(1);
    });

    it("tells a card that has gone nothing, and sends nothing for it", async () => {
        const { inner, executeDax } = fakeProxy();
        const proxy = scheduledProxy(inner, new QueryScheduler());
        const asking = vi.fn();
        const gaveUp = vi.fn();
        const gone = new AbortController();
        gone.abort();
        const result = withPriority("normal", () => proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"), { signal: gone.signal, asking, gaveUp });
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(asking).not.toHaveBeenCalled();
        expect(gaveUp).not.toHaveBeenCalled();
        expect(executeDax).not.toHaveBeenCalled();
    });

    it("tells a card that left a shared request nothing when it gives up, and still tells the card that stayed", async () => {
        const { inner, executeDax } = fakeProxy();
        let fail: (error: unknown) => void = () => {};
        executeDax.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
        const proxy = scheduledProxy(inner, new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} }));
        const leaving = new AbortController();
        const left = { signal: leaving.signal, asking: vi.fn(), gaveUp: vi.fn() };
        const stayed = { signal: new AbortController().signal, asking: vi.fn(), gaveUp: vi.fn() };
        const one = withPriority("normal", () => proxy.semanticModel.executeDax("ws", "left", "EVALUATE A"), left);
        const two = withPriority("normal", () => proxy.semanticModel.executeDax("ws", "left", "EVALUATE A"), stayed);
        await vi.advanceTimersByTimeAsync(0);
        expect(executeDax).toHaveBeenCalledTimes(1);
        leaving.abort();
        fail(apiError(429));
        await expect(one).rejects.toThrow(BUSY_MESSAGE);
        await expect(two).rejects.toThrow(BUSY_MESSAGE);
        expect(left.asking.mock.calls).toEqual([["ws/left"]]);
        expect(left.gaveUp).not.toHaveBeenCalled();
        expect(stayed.gaveUp.mock.calls).toEqual([["ws/left", recoveriesOf("ws/left")]]);
    });

    it("tells every card sharing a request that gave up busy which recovery the busy answer is from", async () => {
        const { inner, executeDax } = fakeProxy();
        executeDax.mockRejectedValue(apiError(429));
        const proxy = scheduledProxy(inner, new QueryScheduler({ maxRetries: 0, random: () => 0, log: () => {} }));
        const first = { asking: vi.fn(), gaveUp: vi.fn() };
        const second = { asking: vi.fn(), gaveUp: vi.fn() };
        const one = withPriority("normal", () => proxy.semanticModel.executeDax("ws", "shared", "EVALUATE A"), first);
        const two = withPriority("normal", () => proxy.semanticModel.executeDax("ws", "shared", "EVALUATE A"), second);
        await expect(one).rejects.toThrow(BUSY_MESSAGE);
        await expect(two).rejects.toThrow(BUSY_MESSAGE);
        expect(executeDax).toHaveBeenCalledTimes(1);
        expect(first.gaveUp.mock.calls).toEqual([["ws/shared", recoveriesOf("ws/shared")]]);
        expect(second.gaveUp.mock.calls).toEqual(first.gaveUp.mock.calls);
    });

    it("lets a request a lead card starts on screen in ahead of the requests waiting; one it starts in the background stays there", async () => {
        const sent: string[] = [];
        const first = deferred<void>();
        const executeDax = vi.fn(async (_workspace: string, _model: string, query: string) => {
            sent.push(query);
            if (query === "EVALUATE A") await first.promise;
            return { data: new ArrayBuffer(0), requestId: "r" };
        });
        const inner = {
            semanticModel: { executeDax, executeDaxJson: vi.fn() },
            lakehouse: { executeSql: vi.fn() },
            warehouse: { executeSql: vi.fn() },
        } as unknown as IFabricApiProxy;
        const scheduler = new QueryScheduler({ concurrency: 1 });
        const proxy = scheduledProxy(inner, scheduler);
        const lead = { signal: new AbortController().signal, lead: true };
        const results = [
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE A"),
            proxy.semanticModel.executeDax("ws", "m", "EVALUATE B"),
            withPriority("normal", () => proxy.semanticModel.executeDax("ws", "m", "EVALUATE C"), lead),
        ];
        await vi.advanceTimersByTimeAsync(0);
        first.resolve();
        await Promise.all(results);
        expect(sent).toEqual(["EVALUATE A", "EVALUATE C", "EVALUATE B"]);

        const background = withPriority("low", () => proxy.semanticModel.executeDax("ws", "m", "EVALUATE D"), lead);
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 1 });
        await background;
    });
});

describe("a throttle sent in an HTTP 200, through the SDK", () => {
    type Reply = { data: unknown; requestId: string };

    function clientWith(replies: () => Reply, daxProtocol?: "json") {
        const executeDax = vi.fn(async () => replies());
        const executeDaxJson = vi.fn(async () => replies());
        const inner = {
            semanticModel: { executeDax, executeDaxJson },
            lakehouse: { executeSql: vi.fn() },
            warehouse: { executeSql: vi.fn() },
        } as unknown as IFabricApiProxy;
        const client = new FabricClient({
            proxy: scheduledProxy(inner, new QueryScheduler({ random: () => 1 })),
            semanticModels: { model: { workspaceId: "ws", itemId: "bde54d4a" } },
            daxProtocol,
        } as FabricClientConfig);
        return { model: client.semanticModel("model"), executeDax, executeDaxJson };
    }

    it("retries it, and caches only the answer", async () => {
        const replies = [errorTable("3238002688", THROTTLED), answerTable(7)];
        const { model, executeDax } = clientWith(() => ({ data: replies.shift() ?? answerTable(), requestId: "r" }));
        const result = model.query("EVALUATE A");
        await vi.advanceTimersByTimeAsync(1000);
        await expect(result).resolves.toMatchObject({ status: "success", fromCache: false });
        expect(executeDax).toHaveBeenCalledTimes(2);

        await expect(model.query("EVALUATE A")).resolves.toMatchObject({ status: "success", fromCache: true });
        expect(executeDax).toHaveBeenCalledTimes(2);
    });

    it("shows the busy message after a minute, never caches it, and the next ask sends a real query", async () => {
        let throttling = true;
        const { model, executeDax } = clientWith(() => ({
            data: throttling ? errorTable("3238002688", THROTTLED) : answerTable(),
            requestId: "r",
        }));
        const result = model.query("EVALUATE A");
        await vi.advanceTimersByTimeAsync(60_000);
        const busy = await result;
        expect(busy).toMatchObject({ status: "error", fromCache: false, error: { category: "api", message: BUSY_MESSAGE } });
        expect(isBusyMessage(busy.status === "error" ? busy.error.message : "")).toBe(true);
        expect(executeDax).toHaveBeenCalledTimes(8);

        // The model stays paused for one more backoff, at most 15 s.
        throttling = false;
        const again = model.query("EVALUATE A");
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(again).resolves.toMatchObject({ status: "success", fromCache: false });
        expect(executeDax).toHaveBeenCalledTimes(9);
    });

    it("pauses only the model that throttled; another model's queries carry on", async () => {
        let throttle = true;
        const executeDax = vi.fn(async (_workspaceId: string, itemId: string) => {
            const throttled = itemId === "bde54d4a" && throttle;
            throttle &&= !throttled;
            return { data: throttled ? errorTable("3238002688", THROTTLED) : answerTable(), requestId: "r" };
        });
        const inner = {
            semanticModel: { executeDax, executeDaxJson: vi.fn() },
            lakehouse: { executeSql: vi.fn() },
            warehouse: { executeSql: vi.fn() },
        } as unknown as IFabricApiProxy;
        const client = new FabricClient({
            proxy: scheduledProxy(inner, new QueryScheduler({ random: () => 1 })),
            semanticModels: { vl: { workspaceId: "ws", itemId: "bde54d4a" }, cc: { workspaceId: "ws", itemId: "648411c2" } },
        } as FabricClientConfig);
        const sentTo = (itemId: string) => executeDax.mock.calls.filter((call) => call[1] === itemId).length;

        const first = client.semanticModel("vl").query("EVALUATE A");
        await vi.advanceTimersByTimeAsync(0);
        const second = client.semanticModel("vl").query("EVALUATE B");
        await expect(client.semanticModel("cc").query("EVALUATE A")).resolves.toMatchObject({ status: "success" });
        expect(sentTo("648411c2")).toBe(1);
        expect(sentTo("bde54d4a")).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        await expect(Promise.all([first, second])).resolves.toMatchObject([{ status: "success" }, { status: "success" }]);
        expect(sentTo("bde54d4a")).toBe(3);
    });

    it("leaves a real query error as it was: sent once, and cached", async () => {
        const { model, executeDax } = clientWith(() => ({ data: fromBase64(realErrorTable.base64), requestId: "r" }));
        const result = await model.query("EVALUATE 'Access Scope'");
        expect(result).toMatchObject({ status: "error", fromCache: false, error: { category: "query" } });
        expect(result.status === "error" && result.error.message).toMatch(/Cannot find table/);
        expect(executeDax).toHaveBeenCalledTimes(1);

        await expect(model.query("EVALUATE 'Access Scope'")).resolves.toMatchObject({ fromCache: true });
        expect(executeDax).toHaveBeenCalledTimes(1);
        await expect(model.query("EVALUATE 'Access Scope'", { bypassCache: true })).resolves.toMatchObject({ fromCache: false });
        expect(executeDax).toHaveBeenCalledTimes(2);
    });

    it("leaves a query error that names a rate limit as it was: sent once, cached, its message intact", async () => {
        const message = "Query (5, 59) Cannot find table '<oii>Rate Limit</oii>'.";
        const { model, executeDax } = clientWith(() => ({ data: errorTable("3241803779", message), requestId: "r" }));
        const result = await model.query("EVALUATE 'Rate Limit'");
        expect(result).toMatchObject({ status: "error", fromCache: false, error: { category: "query", message } });
        expect(executeDax).toHaveBeenCalledTimes(1);
        await expect(model.query("EVALUATE 'Rate Limit'")).resolves.toMatchObject({ fromCache: true });
        expect(executeDax).toHaveBeenCalledTimes(1);

        const json = clientWith(() => ({ data: { results: [{ error: { code: "DAX", message: "Cannot find table 'Throttle Log'." } }] }, requestId: "r" }), "json");
        await expect(json.model.query("EVALUATE 'Throttle Log'")).resolves.toMatchObject({ status: "error", error: { category: "query" } });
        expect(json.executeDaxJson).toHaveBeenCalledTimes(1);
    });

    it("retries a throttle in a JSON reply, and leaves a JSON query error alone", async () => {
        const replies: unknown[] = [
            { error: { code: "TooManyRequests", message: THROTTLED } },
            { results: [{ tables: [{ rows: [{ "[Value]": 1 }] }] }] },
            { results: [{ error: { code: "DAX", message: "The column 'X'[Y] cannot be found" } }] },
        ];
        const { model, executeDaxJson } = clientWith(() => ({ data: replies.shift(), requestId: "r" }), "json");
        const result = model.query("EVALUATE A");
        await vi.advanceTimersByTimeAsync(1000);
        await expect(result).resolves.toMatchObject({ status: "success", table: { rows: [[1]] } });
        expect(executeDaxJson).toHaveBeenCalledTimes(2);

        await expect(model.query("EVALUATE B")).resolves.toMatchObject({ status: "error", error: { category: "query" } });
        expect(executeDaxJson).toHaveBeenCalledTimes(3);
    });
});
