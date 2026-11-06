//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "./to-data-table";

/**
 * The org mapping table keeps every column of the customer's org export, so
 * the app can group and filter by whichever of them a customer loaded:
 * department, function, location, cost centre and so on.
 *
 * Every org-bound query is written against `Organization`, the column the
 * model always has, and {@link withOrgAttribute} swaps in the chosen column.
 */
export const ORG_TABLE = "Chat + Agent Org Data";
export const DEFAULT_ORG_ATTRIBUTE = "Organization";

const AUTHORED_REFERENCE = `'${ORG_TABLE}'[${DEFAULT_ORG_ATTRIBUTE}]`;
const AUTHORED_RESULT_COLUMN = `${ORG_TABLE}[${DEFAULT_ORG_ATTRIBUTE}]`;

export interface OrgAttribute {
    /** The model column name, e.g. `officeLocation`. */
    column: string;
    /** For headings and filters, e.g. `Office location`. */
    label: string;
    /** Lower-case for prose, e.g. `office location`. */
    noun: string;
    /** Lower-case plural for prose, e.g. `office locations`. */
    plural: string;
}

/** A DAX reference to an org column, with `]` escaped as DAX requires. */
export function orgColumnRef(column: string): string {
    return `'${ORG_TABLE}'[${column.replace(/]/g, "]]")}]`;
}

function humanise(column: string): string {
    const words = column
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim()
        .split(/\s+/)
        .map((word, index) => {
            const isAcronym = word.length > 1 && word === word.toUpperCase();
            if (isAcronym) return word;
            return index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase();
        });
    return words.join(" ") || column;
}

function pluralise(phrase: string): string {
    const words = phrase.split(" ");
    const last = words.pop() ?? "";
    const isAcronym = last.length > 1 && last === last.toUpperCase();
    const plural = isAcronym
        ? `${last}s`
        : /[^aeiou]y$/i.test(last)
          ? `${last.slice(0, -1)}ies`
          : /(s|x|z|ch|sh)$/i.test(last)
            ? `${last}es`
            : `${last}s`;
    return [...words, plural].join(" ");
}

export function describeOrgAttribute(column: string): OrgAttribute {
    const label = humanise(column);
    const noun = label
        .split(" ")
        .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()))
        .join(" ");
    return { column, label, noun, plural: pluralise(noun) };
}

/**
 * Prefixes a noun phrase with "a" or "an" by how its first word sounds:
 * "an organization", "a unit", "an HR team", "a UK region".
 */
export function withIndefiniteArticle(phrase: string): string {
    const first = phrase.trim().split(/\s+/)[0] ?? "";
    const isAcronym = first.length > 1 && first === first.toUpperCase() && /[A-Z]/.test(first);
    const vowelSound = isAcronym
        ? /^[AEFHILMNORSX]/.test(first)
        : /^(hour|honest|honou?r|heir)/i.test(first) ||
          (/^[aeiou]/i.test(first) && !/^(u[nrst]i|us[eu]|uk|eu|one|once)/i.test(first));
    return `${vowelSound ? "an" : "a"} ${phrase}`;
}

export interface OrgColumnStatistic {
    column: string;
    cardinality: number;
    /** `undefined` for non-text columns. */
    maxLength: number | undefined;
}

// Identifiers and join keys: grouping by them gives one bar per person.
// The suffix test is case-sensitive so "Paid" or "Grid" are not caught.
const IDENTIFIER_SUFFIX = /(^|[_\s-])(id|Id|ID)$|[a-z0-9](Id|ID)$/;
const IDENTIFIER_WORD = /upn|principal|e-?mail|^mail$|normali[sz]ed|^RowNumber-/i;
// Anything past this is a list of people, not a way to slice them.
const MAX_GROUPS = 500;

/**
 * The org columns worth grouping by: text columns with at least two values
 * and fewer distinct values than half the people in the table, excluding
 * identifiers. `Organization` leads when it qualifies; the rest are
 * alphabetical by label.
 */
export function pickOrgAttributes(stats: readonly OrgColumnStatistic[], people: number): string[] {
    const ceiling = Math.min(MAX_GROUPS, Math.max(50, Math.floor(people / 2)));
    const picked = stats
        .filter(
            (stat) =>
                stat.maxLength !== undefined &&
                stat.cardinality >= 2 &&
                stat.cardinality <= ceiling &&
                !IDENTIFIER_SUFFIX.test(stat.column) &&
                !IDENTIFIER_WORD.test(stat.column),
        )
        .map((stat) => stat.column);

    return [...new Set(picked)].sort((a, b) => {
        if (a === DEFAULT_ORG_ATTRIBUTE) return -1;
        if (b === DEFAULT_ORG_ATTRIBUTE) return 1;
        return humanise(a).localeCompare(humanise(b));
    });
}

/**
 * Rebinds a query authored against `Organization` to another org column:
 * the DAX reference, the result-column key its metadata is looked up by, and
 * the "Organization" display names and chart titles. The cleaned field `name`
 * stays the same, so Vega specs and grid columns keep working unchanged.
 */
export function withOrgAttribute<
    T extends { query: string; columnMetadata?: ColumnMetadataMap; vegaLiteSpec?: unknown },
>(config: T, attribute: OrgAttribute): T {
    if (attribute.column === DEFAULT_ORG_ATTRIBUTE) return config;

    const next: T = {
        ...config,
        query: config.query.replaceAll(AUTHORED_REFERENCE, orgColumnRef(attribute.column)),
    };

    if (config.columnMetadata) {
        const columnMetadata: ColumnMetadataMap = {};
        for (const [key, definition] of Object.entries(config.columnMetadata)) {
            const relabelled =
                definition.displayName === DEFAULT_ORG_ATTRIBUTE ? { ...definition, displayName: attribute.label } : definition;
            columnMetadata[key === AUTHORED_RESULT_COLUMN ? `${ORG_TABLE}[${attribute.column}]` : key] = relabelled;
        }
        next.columnMetadata = columnMetadata;
    }

    if (config.vegaLiteSpec !== undefined) {
        next.vegaLiteSpec = relabelTitles(config.vegaLiteSpec, attribute.label) as T["vegaLiteSpec"];
    }
    return next;
}

/** Swaps every `title: "Organization"` in a spec — axes, legends, tooltips — for the attribute's label. */
function relabelTitles(value: unknown, label: string): unknown {
    if (Array.isArray(value)) return value.map((entry) => relabelTitles(entry, label));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            key === "title" && entry === DEFAULT_ORG_ATTRIBUTE ? label : relabelTitles(entry, label),
        ]),
    );
}
