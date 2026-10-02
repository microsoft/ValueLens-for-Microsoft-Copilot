//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { addQueryDefinitions } from "@/lib/dax-filters";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection as connection, FORMAT_CREDITS } from "../shared";
import modelTermsQuery from "./commercial-terms.dax?raw";
import { RATE_MEASURES, type ModelMeasure } from "./rate-measures";

/**
 * The prices typed in the app: the credit terms on the Consumption page, and
 * the licence price and exchange rate on the Value page. A credit term left
 * empty keeps the model's own, which comes from the Lakehouse
 * `commercial_terms` table or the report's parameters.
 */
export interface CommercialTermsValues {
    /** Pay-as-you-go price of one Copilot credit, in US dollars. */
    creditRate?: number;
    /** Price of one prepaid Capacity Pack credit, in US dollars. */
    prepaidCreditRate?: number;
    /** Capacity Pack credits Cowork draws down before paying as it goes. */
    prepaidCreditBalance?: number;
    /** Microsoft 365 Copilot licence price per user per month, in US dollars. Empty uses the list price. */
    licensePrice?: number;
    /** How much of ValueLens's currency one US dollar buys. Empty leaves costs in dollars. */
    exchangeRate?: number;
}

/** The Microsoft 365 Copilot US list price, per user per month, used when no licence price is typed in. */
export const LICENSE_LIST_PRICE = 30;

/** The highest licence price and exchange rate the app accepts. */
export const LICENSE_PRICE_MAX = 1000;
export const EXCHANGE_RATE_MAX = 100000;

export type CommercialTermKey = keyof CommercialTermsValues;

/**
 * The model's rate inputs, all on its Settings table, and the term each
 * reads. The `commercial_terms` table fills both products' rates from the
 * same columns, and only Cowork draws down a pack: Copilot Studio's export
 * records which of its credits were prepaid.
 */
const INPUTS: readonly { name: string; term: CommercialTermKey }[] = [
    { name: "Cowork PAYG Rate Value", term: "creditRate" },
    { name: "Studio PAYG Rate Value", term: "creditRate" },
    { name: "Cowork Prepaid Rate Value", term: "prepaidCreditRate" },
    { name: "Studio Prepaid Rate Value", term: "prepaidCreditRate" },
    { name: "Cowork Capacity Pack Balance Value", term: "prepaidCreditBalance" },
];

const INPUT_TABLE = "Settings";

/** The range the `Ingest_CommercialTerms` notebook accepts for a credit rate. */
export const RATE_MIN = 0.001;
export const RATE_MAX = 0.05;

const REFERENCE = /\[([^\]]+)\]/g;
const OWN_MEASURE = /\bMEASURE\s+(?:'(?:[^']|'')*'|[A-Za-z_][\w ]*)?\s*\[([^\]]+)\]/gi;

function references(text: string): Set<string> {
    return new Set(Array.from(text.matchAll(REFERENCE), (match) => match[1]));
}

interface ChainMeasure extends ModelMeasure {
    refs: string[];
    /** The rate inputs this measure reaches, directly or through others. */
    inputs: Set<string>;
}

const inputNames = new Set(INPUTS.map((input) => input.name));

const chain: ReadonlyMap<string, ChainMeasure> = (() => {
    const byName = new Map<string, ChainMeasure>();
    for (const measure of RATE_MEASURES) {
        const refs = [...references(measure.expression)].filter(
            (name) => name !== measure.name && (inputNames.has(name) || RATE_MEASURES.some((m) => m.name === name)),
        );
        byName.set(measure.name, { ...measure, refs, inputs: new Set() });
    }
    const resolve = (name: string, seen: Set<string>): Set<string> => {
        if (inputNames.has(name)) return new Set([name]);
        const measure = byName.get(name);
        if (!measure || seen.has(name)) return new Set();
        if (measure.inputs.size > 0) return measure.inputs;
        seen.add(name);
        for (const ref of measure.refs) for (const input of resolve(ref, seen)) measure.inputs.add(input);
        return measure.inputs;
    };
    for (const name of byName.keys()) resolve(name, new Set());
    return byName;
})();

function quoteTable(table: string): string {
    return `'${table.replace(/'/g, "''")}'`;
}

/** A plain DAX number literal: never in exponent notation, and no more than six decimals. */
export function daxNumber(value: number): string {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
    if (Number.isInteger(value)) return BigInt(value).toString();
    return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function isSet(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** True when any credit term is typed in, so the model's own no longer all apply. */
export function hasCommercialTerms(terms: CommercialTermsValues | undefined): boolean {
    return INPUTS.some((input) => isSet(terms?.[input.term]));
}

/** True when the query shows a figure the terms can change, so it should wait for them. */
export function readsCommercialTerms(query: string): boolean {
    return [...references(query)].some((name) => inputNames.has(name) || chain.has(name));
}

/**
 * Prices a Consumption Central query with the terms typed in on the page.
 *
 * Each rate input the terms set is redefined for the query, and so is every
 * model measure between that input and the query: a model measure reads the
 * model's input whatever the query defines, so `[Cowork Total Cost]` only
 * moves when it and everything beneath it are query measures too. Measures
 * the query already defines are its own and are left alone. Returns the
 * query unchanged when no term is set or it shows no cost.
 */
export function withCommercialTerms(query: string, terms: CommercialTermsValues | undefined): string {
    const overridden = new Set(INPUTS.filter((input) => isSet(terms?.[input.term])).map((input) => input.name));
    if (overridden.size === 0) return query;

    const own = new Set(Array.from(query.matchAll(OWN_MEASURE), (match) => match[1]));
    const wanted = new Set<string>();
    let readsInput = false;

    const visit = (name: string) => {
        if (overridden.has(name)) readsInput = true;
        if (own.has(name) || wanted.has(name)) return;
        const measure = chain.get(name);
        if (!measure || ![...measure.inputs].some((input) => overridden.has(input))) return;
        wanted.add(name);
        measure.refs.forEach(visit);
    };
    references(query).forEach(visit);
    if (wanted.size === 0 && !readsInput) return query;

    const definitions: string[] = [];
    for (const input of INPUTS) {
        const value = terms?.[input.term];
        if (!isSet(value) || own.has(input.name)) continue;
        definitions.push(`MEASURE ${quoteTable(INPUT_TABLE)}[${input.name}] = ${daxNumber(value)}`);
    }
    for (const measure of RATE_MEASURES) {
        if (!wanted.has(measure.name)) continue;
        definitions.push(`MEASURE ${quoteTable(measure.table)}[${measure.name}] =\n${measure.expression.replace(/^\n|\s+$/g, "")}`);
    }
    return addQueryDefinitions(query, definitions);
}

/** Why a typed value cannot be used, or undefined when it can. Empty is allowed: it keeps the default. */
export function validateTerm(term: CommercialTermKey, value: number | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value)) return "Enter a number.";
    if (term === "licensePrice") {
        if (value < 0 || value > LICENSE_PRICE_MAX) return `Enter a price between $0 and $${LICENSE_PRICE_MAX}.`;
        return undefined;
    }
    if (term === "exchangeRate") {
        if (value <= 0) return "Enter a rate above zero.";
        if (value > EXCHANGE_RATE_MAX) return "Enter a smaller rate.";
        return undefined;
    }
    if (term === "prepaidCreditBalance") {
        if (value < 0) return "Enter zero or more credits.";
        if (!Number.isInteger(value)) return "Enter whole credits.";
        if (value > 1e15) return "Enter a smaller balance.";
        return undefined;
    }
    if (value < RATE_MIN || value > RATE_MAX) return `Enter a rate between $${RATE_MIN} and $${RATE_MAX} per credit.`;
    return undefined;
}

/**
 * Reads a typed value: blank is "not set", commas and a leading currency
 * symbol are allowed, and anything else that is not a number comes back as NaN.
 */
export function parseTerm(text: string): number | undefined {
    const cleaned = text.trim().replace(/^[$£€¥]/, "").replace(/,/g, "").trim();
    if (cleaned === "") return undefined;
    return /^\d*\.?\d+$|^\d+\.$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

const modelTermsColumns: ColumnMetadataMap = {
    "[Credit Rate]": { name: "Credit Rate", displayName: "Pay-as-you-go rate", format: "0.0000" },
    "[Prepaid Credit Rate]": { name: "Prepaid Credit Rate", displayName: "Prepaid rate", format: "0.0000" },
    "[Prepaid Credit Balance]": { name: "Prepaid Credit Balance", displayName: "Capacity Pack balance", format: FORMAT_CREDITS },
};

/**
 * The model's own rates and pack balance, before anything typed in the app.
 * Read as Cowork's: Copilot Studio's come from the same `commercial_terms`
 * columns.
 */
export function modelCommercialTerms() {
    return { connection, query: modelTermsQuery, columnMetadata: modelTermsColumns };
}
