//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { createDataApi } from "@microsoft/rayfin-data";
import type { ValueLensSchema } from "../../rayfin/data/schema";

type EntityName = keyof ValueLensSchema;
type Column<E extends EntityName> = keyof ValueLensSchema[E] & string;
type Row = Record<string, unknown>;

/** The names Data API Builder gives an entity's queries, and the entity's columns. */
interface Shape<E extends EntityName> {
    list: string;
    byPk: string;
    columns: { readonly [K in Column<E>]-?: true };
}

const SHAPES: { readonly [E in EntityName]: Shape<E> } = {
    CommercialTerms: {
        list: "commercialTerms",
        byPk: "commercialTerms_by_pk",
        columns: {
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
        },
    },
    ReportPack: {
        list: "reportPacks",
        byPk: "reportPack_by_pk",
        columns: { id: true, name: true, description: true, stages: true, updatedBy: true, updatedAt: true },
    },
    TaskTime: {
        list: "taskTimes",
        byPk: "taskTime_by_pk",
        columns: { id: true, task: true, minLow: true, minTypical: true, minHigh: true, updatedBy: true, updatedAt: true },
    },
};

const ENTITIES = Object.keys(SHAPES) as EntityName[];

/**
 * The app's Data API Builder GraphQL endpoint, held in memory, for tests to
 * run the real Rayfin data client against. Like DAB, it answers with only the
 * fields a request selects, so a read that doesn't ask for a column doesn't
 * get it.
 */
export class FakeDab {
    private readonly tables: { readonly [E in EntityName]: Map<string, Row> } = {
        CommercialTerms: new Map(),
        ReportPack: new Map(),
        TaskTime: new Map(),
    };
    private seeded = 0;

    /** The Rayfin data client, talking to this endpoint. */
    readonly data = createDataApi<ValueLensSchema>({
        post: (_path: string, request: { query: string }) => Promise.resolve(this.answer(request.query)),
    } as unknown as Parameters<typeof createDataApi>[0]);

    /** Puts rows in an entity's table as if saved earlier. A row without an id gets one. */
    seed<E extends EntityName>(entity: E, ...rows: Partial<Record<Column<E>, unknown>>[]): void {
        for (const values of rows) {
            const row = blank(entity);
            for (const [key, value] of Object.entries(values)) row[key] = value instanceof Date ? value.toISOString() : value;
            row.id ??= `00000000-0000-4000-8000-${String(++this.seeded).padStart(12, "0")}`;
            this.tables[entity].set(String(row.id), row);
        }
    }

    /** An entity's rows as the database holds them. */
    rows(entity: EntityName): Row[] {
        return [...this.tables[entity].values()].map((row) => ({ ...row }));
    }

    private answer(query: string): { data?: Row; errors?: { message: string }[] } {
        try {
            const operation = parse(query);
            const data: Row = {};
            for (const field of operation.fields)
                data[field.name] = operation.kind === "query" ? this.read(field) : this.write(field);
            return { data };
        } catch (error) {
            return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
    }

    private read(field: Field): unknown {
        for (const entity of ENTITIES) {
            const { list, byPk } = SHAPES[entity];
            if (field.name === byPk) {
                const row = this.tables[entity].get(String(field.args.id));
                return row ? project(entity, row, field.selection) : null;
            }
            if (field.name === list) {
                const { filter = {}, first, ...rest } = field.args;
                if (Object.keys(rest).length > 0) throw new Error(`The fake doesn't support ${Object.keys(rest).join(", ")}.`);
                const all = [...this.tables[entity].values()].filter((row) => matches(entity, row, filter));
                const rows = first === undefined ? all : all.slice(0, Number(first));
                return page(entity, rows, rows.length < all.length, field.selection);
            }
        }
        throw new Error(`The field \`${field.name}\` does not exist on the type \`Query\`.`);
    }

    private write(field: Field): unknown {
        const [, verb, entity] = /^(create|update|delete)(\w+)$/.exec(field.name) ?? [];
        if (!entity || !Object.hasOwn(SHAPES, entity))
            throw new Error(`The field \`${field.name}\` does not exist on the type \`Mutation\`.`);
        const name = entity as EntityName;
        const table = this.tables[name];
        if (verb === "create") {
            const row = { ...blank(name), ...item(name, field.args.item) };
            if (typeof row.id !== "string" || table.has(row.id)) throw new Error(`Can't create ${name} ${String(row.id)}.`);
            table.set(row.id, row);
            return project(name, row, field.selection);
        }
        const id = String(field.args.id);
        const row = table.get(id);
        if (!row) throw new Error(`${name} ${id} was not found.`);
        if (verb === "update") Object.assign(row, item(name, field.args.item), { id });
        else table.delete(id);
        return project(name, row, field.selection);
    }
}

function blank(entity: EntityName): Row {
    return Object.fromEntries(Object.keys(SHAPES[entity].columns).map((column) => [column, null]));
}

function checkColumn(entity: EntityName, name: string): void {
    if (!Object.hasOwn(SHAPES[entity].columns, name))
        throw new Error(`The field \`${name}\` does not exist on the type \`${entity}\`.`);
}

function item(entity: EntityName, values: unknown): Row {
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`A ${entity} mutation needs an item.`);
    for (const key of Object.keys(values)) checkColumn(entity, key);
    return { ...(values as Row) };
}

/** Only the selected columns of a row, as DAB answers. */
function project(entity: EntityName, row: Row, selection: readonly Field[] | undefined): Row {
    if (!selection?.length) throw new Error(`A ${entity} needs fields selected.`);
    return Object.fromEntries(selection.map((field) => {
        checkColumn(entity, field.name);
        if (field.selection) throw new Error(`\`${field.name}\` has no fields to select.`);
        return [field.name, row[field.name] ?? null];
    }));
}

function page(entity: EntityName, rows: readonly Row[], more: boolean, selection: readonly Field[] | undefined): Row {
    if (!selection?.length) throw new Error(`A list of ${entity} needs fields selected.`);
    return Object.fromEntries(selection.map((field) => {
        if (field.name === "items") return [field.name, rows.map((row) => project(entity, row, field.selection))];
        if (field.name === "hasNextPage") return [field.name, more];
        if (field.name === "endCursor") return [field.name, null];
        throw new Error(`The field \`${field.name}\` does not exist on the type \`${entity}Connection\`.`);
    }));
}

function matches(entity: EntityName, row: Row, filter: unknown): boolean {
    return Object.entries(filter as Row).every(([key, condition]) => {
        if (key === "and") return (condition as unknown[]).every((part) => matches(entity, row, part));
        if (key === "or") return (condition as unknown[]).some((part) => matches(entity, row, part));
        if (key === "not") return !matches(entity, row, condition);
        checkColumn(entity, key);
        const value = row[key] ?? null;
        return Object.entries(condition as Row).every(([operator, operand]) => {
            if (operator === "eq") return value === operand;
            if (operator === "neq") return value !== operand;
            if (operator === "isNull") return (value === null) === operand;
            throw new Error(`The fake doesn't support the ${operator} filter.`);
        });
    });
}

interface Field {
    name: string;
    args: Row;
    selection?: Field[];
}

type Token = { kind: "punctuator" | "name"; text: string } | { kind: "value"; value: string | number };

function tokenize(source: string): Token[] {
    const lexeme = /[\s,]+|([{}()[\]:])|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([_A-Za-z]\w*)/y;
    const tokens: Token[] = [];
    while (lexeme.lastIndex < source.length) {
        const at = lexeme.lastIndex;
        const match = lexeme.exec(source);
        if (!match) throw new Error(`Unexpected text in a GraphQL request: ${source.slice(at, at + 20)}`);
        const [, punctuator, string, number, name] = match;
        if (punctuator) tokens.push({ kind: "punctuator", text: punctuator });
        else if (string) tokens.push({ kind: "value", value: JSON.parse(string) as string });
        else if (number) tokens.push({ kind: "value", value: Number(number) });
        else if (name) tokens.push({ kind: "name", text: name });
    }
    return tokens;
}

/** The query or mutation's top-level fields. Handles the GraphQL Rayfin's data client writes, nothing more. */
function parse(source: string): { kind: "query" | "mutation"; fields: Field[] } {
    const tokens = tokenize(source);
    let at = 0;
    const skip = (text: string): boolean => {
        const token = tokens[at];
        if (token?.kind !== "punctuator" || token.text !== text) return false;
        at++;
        return true;
    };
    const expect = (text: string): void => {
        if (!skip(text)) throw new Error(`Expected "${text}" in a GraphQL request.`);
    };
    const name = (): string => {
        const token = tokens[at++];
        if (token?.kind !== "name") throw new Error("Expected a name in a GraphQL request.");
        return token.text;
    };
    const value = (): unknown => {
        if (skip("[")) {
            const list: unknown[] = [];
            while (!skip("]")) list.push(value());
            return list;
        }
        if (skip("{")) {
            const object: Row = {};
            while (!skip("}")) {
                const key = name();
                expect(":");
                object[key] = value();
            }
            return object;
        }
        const token = tokens[at++];
        if (token?.kind === "value") return token.value;
        if (token?.kind === "name" && token.text === "null") return null;
        if (token?.kind === "name" && (token.text === "true" || token.text === "false")) return token.text === "true";
        throw new Error(`The fake doesn't support the value ${token && "text" in token ? token.text : "at the end"}.`);
    };
    const selection = (): Field[] => {
        expect("{");
        const fields: Field[] = [];
        while (!skip("}")) fields.push(field());
        return fields;
    };
    const field = (): Field => {
        const fieldName = name();
        const args: Row = {};
        if (skip("(")) {
            while (!skip(")")) {
                const key = name();
                expect(":");
                args[key] = value();
            }
        }
        const next = tokens[at];
        return { name: fieldName, args, selection: next?.kind === "punctuator" && next.text === "{" ? selection() : undefined };
    };
    const kind = name();
    if (kind !== "query" && kind !== "mutation") throw new Error(`The fake doesn't support ${kind} operations.`);
    const fields = selection();
    if (at < tokens.length) throw new Error("Unexpected text after a GraphQL operation.");
    return { kind, fields };
}
