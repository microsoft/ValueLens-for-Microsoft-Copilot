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
import { parsePack, type ReportPack } from "@/lib/report-pack";
import type { ValueLensSchema } from "../../rayfin/data/schema";

/** The app keeps one set of terms for everyone, in this row. */
export const COMMERCIAL_TERMS_ID = "00000000-0000-0000-0000-000000000001";
const LOAD_TIMEOUT_MS = 8000;
const MAX_ROWS = 1000;
const ADMIN_WRITE_MESSAGE = "Only admins of the app can change this";

/**
 * Every column of an entity, for a Rayfin read to ask for: without a list, a
 * read returns only each row's id. Naming them as keys makes a column added to
 * or renamed in the entity fail type checking until it's listed here too.
 */
function columns<E extends keyof ValueLensSchema>(
    all: { readonly [K in keyof ValueLensSchema[E] & string]-?: true },
): (keyof ValueLensSchema[E] & string)[] {
    return Object.keys(all) as (keyof ValueLensSchema[E] & string)[];
}

const COMMERCIAL_TERMS_COLUMNS = columns<"CommercialTerms">({
    id: true,
    creditRate: true,
    prepaidCreditRate: true,
    prepaidCreditBalance: true,
    licensePrice: true,
    exchangeRate: true,
    budgetCowork: true,
    budgetStudio: true,
    budgetAzure: true,
    currency: true,
    updatedBy: true,
    updatedAt: true,
});
const TASK_TIME_COLUMNS = columns<"TaskTime">({
    id: true,
    task: true,
    minLow: true,
    minTypical: true,
    minHigh: true,
    updatedBy: true,
    updatedAt: true,
});
const REPORT_PACK_COLUMNS = columns<"ReportPack">({
    id: true,
    name: true,
    description: true,
    stages: true,
    updatedBy: true,
    updatedAt: true,
});

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
    loadReportPacks(): Promise<ReportPack[]>;
    saveReportPack(pack: ReportPack, updatedBy: string | undefined): Promise<ReportPack>;
    deleteReportPack(id: string): Promise<void>;
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
        // Not findById: it can't list columns, so it returns only the id.
        const row = await withTimeout(
            getRayfinClient().data.CommercialTerms
                .select(COMMERCIAL_TERMS_COLUMNS)
                .where({ id: { eq: COMMERCIAL_TERMS_ID } })
                .findFirst(),
            LOAD_TIMEOUT_MS,
        );
        return row ? commercialTermsFromRow(row as unknown as Record<string, unknown>) : null;
    }

    async saveCommercialTerms(patch: CommercialTermsValues, updatedBy: string | undefined): Promise<SavedCommercialTerms> {
        const changed = commercialTermsPatch(patch);
        const stamp = { updatedBy: updatedBy ?? null, updatedAt: new Date() };
        const create = { id: COMMERCIAL_TERMS_ID, ...changed, ...stamp } as unknown as Partial<SavedCommercialTerms>;
        const update = { ...changed, ...stamp } as unknown as Partial<SavedCommercialTerms>;
        const terms = getRayfinClient().data.CommercialTerms;
        const row = await terms.upsert({ id: COMMERCIAL_TERMS_ID }, create, update);
        // The upsert returns only the columns it wrote, so read the row back for the terms other forms set.
        return (await this.loadCommercialTerms()) ?? commercialTermsFromRow(row as unknown as Record<string, unknown>);
    }

    async loadTaskTimes(): Promise<SavedTaskTime[]> {
        const rows = await withTimeout(
            getRayfinClient().data.TaskTime.select(TASK_TIME_COLUMNS).first(MAX_ROWS).execute(),
            LOAD_TIMEOUT_MS,
        );
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

    async loadReportPacks(): Promise<ReportPack[]> {
        const rows = await withTimeout(
            getRayfinClient().data.ReportPack.select(REPORT_PACK_COLUMNS).first(MAX_ROWS).execute(),
            LOAD_TIMEOUT_MS,
        );
        return reportPacksFromRows(rows as unknown as Record<string, unknown>[]);
    }

    async saveReportPack(pack: ReportPack, updatedBy: string | undefined): Promise<ReportPack> {
        const rows = getRayfinClient().data.ReportPack;
        const values = { ...reportPackRow(pack), updatedBy: updatedBy ?? null, updatedAt: new Date() };
        const { id, ...update } = values;
        const row = await rows.upsert(
            { id },
            values as unknown as Parameters<typeof rows.upsert>[1],
            update as unknown as Parameters<typeof rows.upsert>[2],
        );
        return savedPack(row as unknown as Record<string, unknown>);
    }

    async deleteReportPack(id: string): Promise<void> {
        const rows = getRayfinClient().data.ReportPack;
        try {
            await rows.delete({ id });
        } catch (error) {
            if (await rows.findById(id)) throw error;
        }
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

    async loadReportPacks(): Promise<ReportPack[]> {
        return reportPacksFromRows(await this.request<Record<string, unknown>[]>("ReportPack"));
    }

    async saveReportPack(pack: ReportPack, updatedBy: string | undefined): Promise<ReportPack> {
        const row = { ...reportPackRow(pack), updatedBy: updatedBy ?? null, updatedAt: new Date().toISOString() };
        return savedPack(await this.request<Record<string, unknown>>("ReportPack", row.id, "PUT", row));
    }

    async deleteReportPack(id: string): Promise<void> {
        await this.request<void>("ReportPack", id, "DELETE");
    }

    private async request<T>(entity: "CommercialTerms" | "ReportPack" | "TaskTime", id?: string, method = "GET", body?: unknown): Promise<T> {
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
                throw new Error("You don't have access to this app.");
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

/** A pack as a database row: stages as JSON text, as the `ReportPack` entity holds them. */
function reportPackRow(pack: ReportPack): { id: string; name: string; description: string | null; stages: string } {
    const clean = parsePack(pack);
    if (!clean) throw new Error("A report pack needs a name and at least one stage.");
    return { id: clean.id, name: clean.name, description: clean.description ?? null, stages: JSON.stringify(clean.stages) };
}

function savedPack(row: Record<string, unknown>): ReportPack {
    const pack = parsePack(row);
    if (!pack) throw new Error("The saved report pack couldn't be read back.");
    return pack;
}

/** Saved packs by name; rows that no longer name a known stage are skipped. */
function reportPacksFromRows(rows: readonly Record<string, unknown>[]): ReportPack[] {
    return rows
        .flatMap((row) => parsePack(row) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name));
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