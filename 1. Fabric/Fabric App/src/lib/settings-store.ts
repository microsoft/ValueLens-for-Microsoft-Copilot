//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { errorCode, reportAccessDenied } from "@/lib/access";
import { getRayfinClient } from "@/lib/rayfin-client";
import { runtimeConfig } from "@/lib/runtime-config";
import { getAccessToken } from "@/services/rayfin-auth.service";
import { taskTimeKey, type TaskTime, type TaskTimeOverride } from "@/queries/assumptions";
import { COMMERCIAL_TERM_KEYS, type CommercialTermsValues } from "@/queries/consumption/commercial-terms";
import { toCurrencyCode } from "@/lib/currency";

/** The app keeps one set of terms for everyone, in this row. */
export const COMMERCIAL_TERMS_ID = "00000000-0000-0000-0000-000000000001";
const LOAD_TIMEOUT_MS = 8000;
const MAX_ROWS = 1000;
const ADMIN_WRITE_MESSAGE = "Only Analytics Hub admins can change this";

export interface SavedCommercialTerms extends CommercialTermsValues {
    updatedBy?: string;
    updatedAt?: Date;
}

export interface SavedTaskTime extends TaskTimeOverride {
    updatedBy?: string;
    updatedAt?: Date;
}

/** A change to one task: its new times, or null to go back to the model's. */
export interface TaskTimeChange {
    task: string;
    time: TaskTime | null;
}

export interface SettingsStore {
    loadCommercialTerms(): Promise<SavedCommercialTerms | null>;
    saveCommercialTerms(patch: CommercialTermsValues, updatedBy: string | undefined): Promise<SavedCommercialTerms>;
    loadTaskTimes(): Promise<SavedTaskTime[]>;
    saveTaskTimes(changes: readonly TaskTimeChange[], updatedBy: string | undefined): Promise<SavedTaskTime[]>;
}

let store: SettingsStore | undefined;

export function getSettingsStore(): SettingsStore {
    store ??= runtimeConfig().host === "azure" ? new HttpSettingsStore() : new RayfinSettingsStore();
    return store;
}

/** The row id a task is saved under, worked out from its name. */
export async function taskTimeId(task: string): Promise<string> {
    const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`valuelens:task-time:${taskTimeKey(task)}`)),
    ).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class RayfinSettingsStore implements SettingsStore {
    async loadCommercialTerms(): Promise<SavedCommercialTerms | null> {
        const row = await withTimeout(getRayfinClient().data.CommercialTerms.findById(COMMERCIAL_TERMS_ID), LOAD_TIMEOUT_MS);
        return row ? commercialTermsFromRow(row as unknown as Record<string, unknown>) : null;
    }

    async saveCommercialTerms(patch: CommercialTermsValues, updatedBy: string | undefined): Promise<SavedCommercialTerms> {
        const changed = commercialTermsPatch(patch);
        const stamp = { updatedBy: updatedBy ?? null, updatedAt: new Date() };
        const create = { id: COMMERCIAL_TERMS_ID, ...changed, ...stamp } as unknown as Partial<SavedCommercialTerms>;
        const update = { ...changed, ...stamp } as unknown as Partial<SavedCommercialTerms>;
        const terms = getRayfinClient().data.CommercialTerms;
        const row = await terms.upsert({ id: COMMERCIAL_TERMS_ID }, create, update);
        return commercialTermsFromRow(row as unknown as Record<string, unknown>);
    }

    async loadTaskTimes(): Promise<SavedTaskTime[]> {
        const rows = await withTimeout(getRayfinClient().data.TaskTime.first(MAX_ROWS).execute(), LOAD_TIMEOUT_MS);
        return dedupeTaskTimes(rows as unknown as Record<string, unknown>[]);
    }

    async saveTaskTimes(changes: readonly TaskTimeChange[], updatedBy: string | undefined): Promise<SavedTaskTime[]> {
        const results = await Promise.allSettled(changes.map((change) => this.applyTaskTime(change, updatedBy)));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
        return this.loadTaskTimes();
    }

    private async applyTaskTime(change: TaskTimeChange, updatedBy: string | undefined): Promise<void> {
        const id = await taskTimeId(change.task);
        const rows = getRayfinClient().data.TaskTime;
        if (change.time === null) {
            try {
                await rows.delete({ id });
            } catch (error) {
                if (await rows.findById(id)) throw error;
            }
            return;
        }
        const values = {
            task: change.task,
            minLow: change.time.low,
            minTypical: change.time.typical,
            minHigh: change.time.high,
            updatedBy: updatedBy ?? null,
            updatedAt: new Date(),
        };
        await rows.upsert(
            { id },
            { id, ...values } as unknown as Parameters<typeof rows.upsert>[1],
            values as unknown as Parameters<typeof rows.upsert>[2],
        );
    }
}

class HttpSettingsStore implements SettingsStore {
    async loadCommercialTerms(): Promise<SavedCommercialTerms | null> {
        const rows = await this.request<Record<string, unknown>[]>("CommercialTerms");
        const row = rows.find((candidate) => candidate.id === COMMERCIAL_TERMS_ID) ?? rows[0];
        return row ? commercialTermsFromRow(row) : null;
    }

    async saveCommercialTerms(patch: CommercialTermsValues, _updatedBy: string | undefined): Promise<SavedCommercialTerms> {
        void _updatedBy;
        const existing = await this.loadCommercialTerms();
        const body = { id: COMMERCIAL_TERMS_ID, ...existing, ...commercialTermsPatch(patch) };
        const saved = await this.request<Record<string, unknown>>("CommercialTerms", COMMERCIAL_TERMS_ID, "PUT", body);
        return commercialTermsFromRow(saved);
    }

    async loadTaskTimes(): Promise<SavedTaskTime[]> {
        return dedupeTaskTimes(await this.request<Record<string, unknown>[]>("TaskTime"));
    }

    async saveTaskTimes(changes: readonly TaskTimeChange[], _updatedBy: string | undefined): Promise<SavedTaskTime[]> {
        void _updatedBy;
        const results = await Promise.allSettled(changes.map(async (change) => {
            const id = await taskTimeId(change.task);
            if (change.time === null) {
                await this.request<void>("TaskTime", id, "DELETE");
                return;
            }
            await this.request("TaskTime", id, "PUT", {
                id,
                task: change.task,
                minLow: change.time.low,
                minTypical: change.time.typical,
                minHigh: change.time.high,
            });
        }));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
        return this.loadTaskTimes();
    }

    private async request<T>(entity: "CommercialTerms" | "TaskTime", id?: string, method = "GET", body?: unknown): Promise<T> {
        const send = async (forceRefresh: boolean) => {
            const token = await getAccessToken(forceRefresh ? { forceRefresh } : undefined);
            return fetch(`/api/settings/${entity}${id ? `/${encodeURIComponent(id)}` : ""}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        };
        let response = await send(false);
        // A cached token can predate a role assignment, so retry once with a fresh one.
        if (response.status === 401 || response.status === 403)
            response = await send(true);
        if (response.status === 403) {
            const code = errorCode(await response.text());
            if (code === "NotAViewer") {
                reportAccessDenied(code);
                throw new Error("You don't have access to Analytics Hub.");
            }
            throw new Error(ADMIN_WRITE_MESSAGE);
        }
        if (!response.ok)
            throw new Error(`Settings API returned ${response.status}.`);
        if (response.status === 204)
            return undefined as T;
        return await response.json() as T;
    }
}

function commercialTermsPatch(patch: CommercialTermsValues): Record<string, unknown> {
    const changed: Record<string, unknown> = {};
    for (const key of COMMERCIAL_TERM_KEYS) {
        if (Object.hasOwn(patch, key)) changed[key] = patch[key] ?? null;
    }
    if (Object.hasOwn(patch, "currency")) changed.currency = toCurrencyCode(patch.currency) ?? null;
    return changed;
}

function commercialTermsFromRow(row: Record<string, unknown>): SavedCommercialTerms {
    const updatedAt = row.updatedAt ? new Date(row.updatedAt as string | Date) : undefined;
    return {
        creditRate: toOptionalNumber(row.creditRate),
        prepaidCreditRate: toOptionalNumber(row.prepaidCreditRate),
        prepaidCreditBalance: toOptionalNumber(row.prepaidCreditBalance),
        licensePrice: toOptionalNumber(row.licensePrice),
        exchangeRate: toOptionalNumber(row.exchangeRate),
        budgetCowork: toOptionalNumber(row.budgetCowork),
        budgetStudio: toOptionalNumber(row.budgetStudio),
        budgetAzure: toOptionalNumber(row.budgetAzure),
        currency: toCurrencyCode(row.currency),
        updatedBy: typeof row.updatedBy === "string" && row.updatedBy ? row.updatedBy : undefined,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    };
}

function taskTimeFromRow(row: Record<string, unknown>): SavedTaskTime | undefined {
    const task = typeof row.task === "string" ? row.task : "";
    const low = toNumber(row.minLow);
    const typical = toNumber(row.minTypical);
    const high = toNumber(row.minHigh);
    if (!task || ![low, typical, high].every(Number.isFinite)) return undefined;
    const updatedAt = row.updatedAt ? new Date(row.updatedAt as string | Date) : undefined;
    return {
        task,
        low,
        typical,
        high,
        updatedBy: typeof row.updatedBy === "string" && row.updatedBy ? row.updatedBy : undefined,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    };
}

function dedupeTaskTimes(rows: readonly Record<string, unknown>[]): SavedTaskTime[] {
    const byTask = new Map<string, SavedTaskTime>();
    for (const row of rows) {
        const saved = taskTimeFromRow(row);
        if (!saved) continue;
        const key = taskTimeKey(saved.task);
        const existing = byTask.get(key);
        if (!existing || (saved.updatedAt?.getTime() ?? 0) > (existing.updatedAt?.getTime() ?? 0)) byTask.set(key, saved);
    }
    return [...byTask.values()];
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function toNumber(value: unknown): number {
    return toOptionalNumber(value) ?? Number.NaN;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The app's database didn't answer in time.")), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}