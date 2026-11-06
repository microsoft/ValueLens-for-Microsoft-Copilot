//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { AskError, ASK_HISTORY_TURNS, askQuestion, type AskTurn } from "@/lib/ask-api";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn(async (options?: { forceRefresh?: boolean }) => (options?.forceRefresh ? "fresh" : "cached")) }));
vi.mock("@/services/rayfin-auth.service", () => auth);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("askQuestion", () => {
    it("posts the question and the latest turns with the user's token", async () => {
        const fetchMock = vi.fn(async () => Response.json({ answer: "42.", runs: [] }));
        vi.stubGlobal("fetch", fetchMock);
        const history: AskTurn[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));

        await expect(askQuestion("How many?", history)).resolves.toEqual({ answer: "42.", runs: [] });

        const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(path).toBe("/api/ask");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer cached");
        const body = JSON.parse(init.body as string);
        expect(body.question).toBe("How many?");
        expect(body.history).toEqual(history.slice(-ASK_HISTORY_TURNS));
    });

    it("retries once with a fresh token after a 401", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response("", { status: 401 }))
            .mockResolvedValueOnce(Response.json({ answer: "Yes.", runs: [] }));
        vi.stubGlobal("fetch", fetchMock);

        await askQuestion("Q?");

        expect(auth.getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports the API's error with its code and when to try again", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(
            { error: { code: "AskRateLimited", message: "Too many questions." } },
            { status: 429, headers: { "retry-after": "60" } },
        )));

        const error = await askQuestion("Q?").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AskError);
        expect(error).toMatchObject({ message: "Too many questions.", code: "AskRateLimited", status: 429, retryAfter: 60 });
    });
});
