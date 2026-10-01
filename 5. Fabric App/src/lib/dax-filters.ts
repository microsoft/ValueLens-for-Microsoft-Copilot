//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Applies slicer-style filters to a finished DAX query without the query
 * having to know about them.
 *
 * Every `EVALUATE` body is wrapped as `CALCULATETABLE(<body>, <filters>)`,
 * which is what a report slicer does to the visuals beneath it. `DEFINE`
 * blocks are left alone — query-scoped measures are evaluated where they are
 * used, so they see the filters — and `ORDER BY` / `START AT` stay outside
 * the wrap, where DAX requires them.
 */

type Keyword = "DEFINE" | "EVALUATE" | "ORDER BY" | "START AT";

interface KeywordHit {
    keyword: Keyword;
    start: number;
    end: number;
}

const KEYWORD_PATTERNS: [Keyword, RegExp][] = [
    ["DEFINE", /^DEFINE\b/i],
    ["EVALUATE", /^EVALUATE\b/i],
    ["ORDER BY", /^ORDER\s+BY\b/i],
    ["START AT", /^START\s+AT\b/i],
];

function isWordChar(char: string | undefined): boolean {
    return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Finds the statement keywords that sit at the top level of a query — outside
 * strings, quoted names, bracketed names, comments and parentheses.
 */
function findTopLevelKeywords(query: string): KeywordHit[] {
    const hits: KeywordHit[] = [];
    let depth = 0;
    let i = 0;

    const skipDelimited = (close: string) => {
        // Doubling the closing character escapes it in DAX strings and names.
        i++;
        while (i < query.length) {
            if (query[i] === close) {
                if (query[i + 1] === close) {
                    i += 2;
                    continue;
                }
                i++;
                return;
            }
            i++;
        }
    };

    while (i < query.length) {
        const char = query[i];
        const next = query[i + 1];

        if (char === '"') {
            skipDelimited('"');
        } else if (char === "'") {
            skipDelimited("'");
        } else if (char === "[") {
            skipDelimited("]");
        } else if ((char === "/" && next === "/") || (char === "-" && next === "-")) {
            while (i < query.length && query[i] !== "\n") i++;
        } else if (char === "/" && next === "*") {
            const close = query.indexOf("*/", i + 2);
            i = close === -1 ? query.length : close + 2;
        } else if (char === "(") {
            depth++;
            i++;
        } else if (char === ")") {
            depth--;
            i++;
        } else if (depth === 0 && !isWordChar(query[i - 1]) && /[A-Za-z]/.test(char)) {
            const rest = query.slice(i);
            const match = KEYWORD_PATTERNS.find(([, pattern]) => pattern.test(rest));
            if (match) {
                const length = rest.match(match[1])![0].length;
                hits.push({ keyword: match[0], start: i, end: i + length });
                i += length;
            } else {
                while (isWordChar(query[i])) i++;
            }
        } else {
            i++;
        }
    }

    return hits;
}

/**
 * Wraps every `EVALUATE` body in `CALCULATETABLE(..., filters)`.
 * Returns the query unchanged when there is nothing to apply.
 */
export function applyDaxFilters(query: string, filters: readonly string[]): string {
    if (filters.length === 0) return query;

    const hits = findTopLevelKeywords(query);
    let result = query;

    // Work from the end so earlier offsets stay valid as the text grows.
    for (let index = hits.length - 1; index >= 0; index--) {
        const hit = hits[index];
        if (hit.keyword !== "EVALUATE") continue;

        const bodyEnd = hits[index + 1]?.start ?? query.length;
        const body = query.slice(hit.end, bodyEnd).trim();
        if (!body) continue;

        // The body goes on its own lines so a trailing line comment cannot swallow the filters.
        const wrapped = `\nCALCULATETABLE(\n${body}\n,\n    ${filters.join(",\n    ")}\n)\n`;
        result = result.slice(0, hit.end) + wrapped + result.slice(bodyEnd);
    }

    return result;
}

/**
 * Adds query-scoped definitions such as `MEASURE 'T'[Name] = ...` to a query.
 * A query may have only one `DEFINE`, so they join an existing one or start
 * a new one ahead of the first statement.
 */
export function addQueryDefinitions(query: string, definitions: readonly string[]): string {
    if (definitions.length === 0) return query;

    const block = definitions.map((definition) => `    ${definition.trim()}\n`).join("");
    const define = findTopLevelKeywords(query).find((hit) => hit.keyword === "DEFINE");
    if (define) return `${query.slice(0, define.end)}\n${block}${query.slice(define.end)}`;
    return `DEFINE\n${block}${query}`;
}

/** A DAX string literal, with embedded quotes doubled. */
export function daxString(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

/** Filters `column` to the given values, as a multi-select slicer would. */
export function treatAs(column: string, values: readonly (string | number)[]): string {
    const literals = values.map((value) => (typeof value === "number" ? String(value) : daxString(value)));
    return `TREATAS({${literals.join(", ")}}, ${column})`;
}

function daxDate(iso: string): string {
    const [year, month, day] = iso.split("-").map(Number);
    return `DATE(${year}, ${month}, ${day})`;
}

/** Filters a date column to an inclusive range of ISO `yyyy-mm-dd` dates. */
export function dateBetween(column: string, from: string, to: string): string {
    return `FILTER(ALL(${column}), ${column} >= ${daxDate(from)} && ${column} <= ${daxDate(to)})`;
}
