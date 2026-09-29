//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// DAX returns dates as ISO strings. Vega-Lite neither parses them through
// `timeUnit` nor positions them reliably on a raw `temporal` field — the
// axis draws but every line or bar collapses. Every temporal field must be
// produced by an explicit `toDate` calculate transform.

const specs = Object.entries(
    import.meta.glob<unknown>(["./**/*.json", "!./**/__fixtures__/**"], { eager: true, import: "default" }),
).filter(([, spec]) => JSON.stringify(spec).includes("vega-lite"));

interface Node {
    [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
    return typeof value === "object" && value !== null;
}

function walk(value: unknown, visit: (node: Node) => void) {
    if (Array.isArray(value)) {
        value.forEach((item) => walk(item, visit));
    } else if (isNode(value)) {
        visit(value);
        Object.values(value).forEach((child) => walk(child, visit));
    }
}

function dateFields(spec: unknown): Set<string> {
    const fields = new Set<string>();
    walk(spec, (node) => {
        if (typeof node.calculate === "string" && node.calculate.includes("toDate(") && typeof node.as === "string") {
            fields.add(node.as);
        }
    });
    return fields;
}

function temporalFields(spec: unknown): string[] {
    const fields: string[] = [];
    walk(spec, (node) => {
        if (node.type === "temporal" && typeof node.field === "string") fields.push(node.field);
    });
    return fields;
}

describe("Vega-Lite specs", () => {
    it("are discovered", () => {
        expect(specs.length).toBeGreaterThan(10);
    });

    it.each(specs)("%s parses every temporal field with toDate", (_path, spec) => {
        const parsed = dateFields(spec);
        for (const field of temporalFields(spec)) {
            expect(parsed, `temporal field "${field}" must come from a toDate transform`).toContain(field);
        }
    });
});
