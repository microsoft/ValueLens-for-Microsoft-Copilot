//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// Captures a .dax file's live result as a JSON fixture for the render tests.
//
// The render specs assert bar geometry against real query output, so the
// fixtures must be refreshed from the model rather than hand-edited. Usage:
//
//   $env:PBI_GROUP_ID   = "<workspace id>"
//   $env:PBI_DATASET_ID = "<semantic model id>"
//   $env:PBI_TOKEN = (az account get-access-token --resource `
//       "https://analysis.windows.net/powerbi/api" --query accessToken -o tsv)
//   node scripts/capture-query-fixture.mjs src/queries/work/surface-usage.dax `
//       src/queries/work/__fixtures__/surface-usage.rows.json
//
// Omit the output path to print rows to stdout. Set MAX_ROWS to truncate.
import { readFileSync, writeFileSync } from "node:fs";

const GROUP = requireEnv("PBI_GROUP_ID");
const DATASET = requireEnv("PBI_DATASET_ID");

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`set ${name} first`);
    return value;
}

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/capture-query-fixture.mjs <file.dax> [out.json]");

// Strip any BOM - it survives into the request body and returns a 400.
const query = readFileSync(file, "utf8").replace(/^\uFEFF/, "");

const token = requireEnv("PBI_TOKEN");

const res = await fetch(
    `https://api.powerbi.com/v1.0/myorg/groups/${GROUP}/datasets/${DATASET}/executeQueries`,
    {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
    },
);

if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error((await res.text()).slice(0, 1500));
    process.exit(1);
}

const table = (await res.json()).results[0].tables[0];
const out = process.argv[3];
const limit = Number(process.env.MAX_ROWS ?? table.rows.length);
const rows = table.rows.slice(0, limit);
console.log(`rows: ${rows.length}`);
console.log("columns:", Object.keys(rows[0] ?? {}).join(" | "));
if (out) {
    writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    console.log(`wrote ${out}`);
} else {
    console.log(JSON.stringify(rows, null, 1));
}
