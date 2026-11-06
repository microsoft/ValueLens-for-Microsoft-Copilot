//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { getAccessToken } from "@/services/rayfin-auth.service";

export interface AskTurn {
    role: "user" | "assistant";
    content: string;
}

/** One named query the model ran to answer, as the API reports it. */
export interface AskRun {
    name: string;
    page: string;
    description: string;
    filters: { from?: string; to?: string; organizations?: string[] };
    dax: string;
    /** Unset when the query failed. */
    rowCount?: number;
    /** Rows left out because they counted fewer people than the minimum. */
    suppressed?: number;
    truncated?: boolean;
    error?: string;
}

export interface AskReply {
    answer: string;
    runs: AskRun[];
}

export class AskError extends Error {
    constructor(message: string, readonly code: string, readonly status: number, readonly retryAfter?: number) {
        super(message);
        this.name = "AskError";
    }
}

/** The API keeps this many earlier turns; older ones are dropped before sending. */
export const ASK_HISTORY_TURNS = 8;

/** Asks the Azure host's `/api/ask`, which answers from the named queries alone, as the signed-in user. */
export async function askQuestion(question: string, history: readonly AskTurn[] = []): Promise<AskReply> {
    const body = JSON.stringify({ question, history: history.slice(-ASK_HISTORY_TURNS) });
    const send = async (forceRefresh: boolean) => {
        const token = await getAccessToken(forceRefresh ? { forceRefresh } : undefined);
        return fetch("/api/ask", {
            method: "POST",
            cache: "no-store",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body,
        });
    };
    let response = await send(false);
    // A cached token can predate a role assignment, so retry once with a fresh one.
    if (response.status === 401 || response.status === 403)
        response = await send(true);
    if (!response.ok) {
        let code = "AskFailed";
        let message = `Ask returned ${response.status}.`;
        try {
            const error = (await response.json() as { error?: { code?: unknown; message?: unknown } }).error;
            if (typeof error?.code === "string") code = error.code;
            if (typeof error?.message === "string") message = error.message;
        } catch { /* not JSON */ }
        const retry = Number(response.headers.get("retry-after"));
        throw new AskError(message, code, response.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    const reply = await response.json() as Partial<AskReply>;
    return { answer: typeof reply.answer === "string" ? reply.answer : "", runs: Array.isArray(reply.runs) ? reply.runs : [] };
}
