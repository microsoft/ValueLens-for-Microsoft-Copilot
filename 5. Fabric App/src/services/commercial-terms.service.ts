//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { getRayfinClient } from "@/lib/rayfin-client";
import type { CommercialTermsValues } from "@/queries/consumption/commercial-terms";

/** The app keeps one set of terms for everyone, in this row. */
export const COMMERCIAL_TERMS_ID = "00000000-0000-0000-0000-000000000001";

/** How long to wait for the app's database before pricing with the model's terms. */
const LOAD_TIMEOUT_MS = 8000;

export interface SavedCommercialTerms extends CommercialTermsValues {
    updatedBy?: string;
    updatedAt?: Date;
}

function toNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function fromRow(row: Record<string, unknown>): SavedCommercialTerms {
    const updatedAt = row.updatedAt ? new Date(row.updatedAt as string | Date) : undefined;
    return {
        creditRate: toNumber(row.creditRate),
        prepaidCreditRate: toNumber(row.prepaidCreditRate),
        prepaidCreditBalance: toNumber(row.prepaidCreditBalance),
        updatedBy: typeof row.updatedBy === "string" && row.updatedBy ? row.updatedBy : undefined,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    };
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

/** The terms saved in the app, or null when nobody has saved any. */
export async function loadCommercialTerms(): Promise<SavedCommercialTerms | null> {
    const row = await withTimeout(getRayfinClient().data.CommercialTerms.findById(COMMERCIAL_TERMS_ID), LOAD_TIMEOUT_MS);
    return row ? fromRow(row as unknown as Record<string, unknown>) : null;
}

/**
 * Saves the terms for everyone. A term left undefined is cleared, so the
 * model's own applies to it again.
 */
export async function saveCommercialTerms(
    values: CommercialTermsValues,
    updatedBy: string | undefined,
): Promise<SavedCommercialTerms> {
    // The database clears a column only when sent null; undefined is left out of the mutation.
    const fields = {
        creditRate: values.creditRate ?? null,
        prepaidCreditRate: values.prepaidCreditRate ?? null,
        prepaidCreditBalance: values.prepaidCreditBalance ?? null,
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
    } as unknown as Partial<SavedCommercialTerms>;
    const terms = getRayfinClient().data.CommercialTerms;
    const row = await terms.upsert({ id: COMMERCIAL_TERMS_ID }, { id: COMMERCIAL_TERMS_ID, ...fields }, fields);
    return fromRow(row as unknown as Record<string, unknown>);
}
