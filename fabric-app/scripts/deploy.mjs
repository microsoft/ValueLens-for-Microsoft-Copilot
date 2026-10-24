//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// Deploys one variant of the app (ValueLens, Consumption Central, or both)
// into a Fabric workspace as its own item:
//
//   node scripts/deploy.mjs --variant both --workspace-uri https://app.fabric.microsoft.com/groups/<id>/list
//
// 1. Finds the products' semantic models in the workspace by name (or takes
//    --vl-model / --cc-model), asking which to use when several match, and
//    writes public/fabric.config.json naming only the models it found. The
//    joined app deploys with one product missing; its switcher then shows
//    the other.
// 2. Gives `rayfin up` the variant's own item id and deployment record, so the
//    three variants deploy side by side into one workspace without updating
//    each other's item. Records are kept in rayfin/.variants/<variant>/.
// 3. Runs `rayfin up`, whose build bakes the variant in (VITE_APP_VARIANT),
//    then puts rayfin.yml and public/fabric.config.json back as they were.
//
// See README.md, "Deploy", for every option.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FABRIC_API = "https://api.fabric.microsoft.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Each variant's item: never the id `valuelens`, which an older app uses. */
export const VARIANTS = {
    vl: { id: "valuelens-fabric-app", name: "ValueLens", products: ["vl"] },
    cc: { id: "consumption-central-fabric-app", name: "Consumption Central", products: ["cc"] },
    both: { id: "valuelens-consumption-central", name: "ValueLens + Consumption Central", products: ["vl", "cc"] },
};

/**
 * How each product's model is recognised: one of its default `names`, a name
 * starting with one of `prefixes` (an installer adds " 2" when the name is
 * taken), or a name containing one of `contains`, as in an installer's
 * `<owner> - <Product> (<suffix>)`. Names matching `exclude` never count.
 */
export const MODEL_NAMES = {
    vl: {
        label: "ValueLens",
        names: ["Analytics Hub Model", "ValueLens Model", "ValueLens - Fabric", "ValueLens - Fabric OneLake"],
        prefixes: ["Analytics Hub Model", "ValueLens"],
        contains: [" - ValueLens"],
        exclude: /consumption/i,
    },
    cc: {
        label: "Consumption Central",
        names: ["Analytics Hub Consumption Model", "ValueLens Consumption Model", "Consumption Central - Fabric"],
        prefixes: ["Analytics Hub Consumption Model", "ValueLens Consumption Model", "Consumption Central"],
        contains: [" - Consumption Central"],
    },
};

/** The per-variant files `rayfin up` keeps in rayfin/. */
const STATE_FILES = [".deployments.json", ".env"];

export function parseArgs(argv) {
    const options = { dryRun: false, yes: false };
    const value = (index, flag) => {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
        return next;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
        const take = () => inline ?? value(i++, flag);
        switch (flag) {
            case "--variant": options.variant = take(); break;
            case "--workspace-uri": options.workspaceUri = take(); break;
            case "--workspace-id": options.workspaceId = take(); break;
            case "--vl-model": options.vlModel = take(); break;
            case "--cc-model": options.ccModel = take(); break;
            case "--model-workspace-id": options.modelWorkspaceId = take(); break;
            case "--data-agent": options.dataAgent = take(); break;
            case "--tenant": options.tenant = take(); break;
            case "--token": options.token = take(); break;
            case "--dry-run": case "-n": options.dryRun = true; break;
            case "--yes": case "-y": options.yes = true; break;
            case "--help": case "-h": options.help = true; break;
            default: throw new Error(`Unknown option ${arg}. Run with --help for the options.`);
        }
    }
    return options;
}

/** The workspace GUID in a Fabric or Power BI workspace URL. */
export function workspaceIdFromUri(uri) {
    const match = /\/groups\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(uri ?? "");
    return match && GUID.test(match[1]) ? match[1].toLowerCase() : undefined;
}

/**
 * The model for one product among a workspace's semantic models: the only
 * one that matches its `MODEL_NAMES`. When several match, none is picked:
 * they come back as `ambiguous`, default names first, for the person
 * deploying to choose from.
 */
export function pickModel(models, product) {
    const { names, prefixes, contains, exclude } = MODEL_NAMES[product];
    const lower = (text) => text.trim().toLowerCase();
    const rank = (model) => {
        const name = lower(model.displayName);
        const index = names.findIndex((candidate) => lower(candidate) === name);
        return index === -1 ? names.length : index;
    };
    const matches = models
        .filter((model) => {
            const name = lower(model.displayName);
            if (exclude?.test(name)) return false;
            return (
                names.some((candidate) => lower(candidate) === name) ||
                prefixes.some((prefix) => name.startsWith(lower(prefix))) ||
                contains.some((part) => name.includes(lower(part)))
            );
        })
        .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
    if (matches.length === 1) return { model: matches[0] };
    return matches.length > 1 ? { ambiguous: matches } : {};
}

/** The model a typed answer picks from a numbered list: its number, id or exact name. */
export function choiceFromAnswer(answer, candidates) {
    const text = (answer ?? "").trim();
    if (!text) return undefined;
    if (/^\d+$/.test(text)) return candidates[Number(text) - 1];
    return candidates.find((model) => model.id.toLowerCase() === text.toLowerCase() || model.displayName.trim() === text);
}

async function askWhichModel(label, candidates) {
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log(`  ${label}: several models match:`);
        candidates.forEach((model, i) => console.log(`    ${i + 1}) ${model.displayName} (${model.id})`));
        for (;;) {
            const choice = choiceFromAnswer(await prompt.question(`  Which is the ${label} model? [1-${candidates.length}] `), candidates);
            if (choice) return choice;
            console.log(`  Type a number from 1 to ${candidates.length}, or the model's id.`);
        }
    } finally {
        prompt.close();
    }
}

/**
 * The config the app reads at run time: the variant, the models found, and
 * a data agent for Ask if one was named. Other keys of an existing config,
 * such as `modules`, `reporting` or `access`, are kept.
 */
export function buildFabricConfig(existing, variant, models, dataAgent) {
    const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
    delete base.ask;
    return {
        ...base,
        app: { ...(base.app ?? {}), variant },
        semanticModels: models,
        ...(dataAgent ? { ask: { workspaceId: dataAgent.workspaceId, itemId: dataAgent.itemId } } : {}),
    };
}

/** rayfin.yml with the variant's item id and name. */
export function variantRayfinYml(yml, variant) {
    const { id, name } = VARIANTS[variant];
    return yml.replace(/^id:.*$/m, `id: ${id}`).replace(/^name:.*$/m, `name: ${name}`);
}

const HELP = `Deploys the app into a Fabric workspace.

  node scripts/deploy.mjs --variant <vl|cc|both> --workspace-uri <url> [options]

  --variant <vl|cc|both>     ValueLens, Consumption Central, or both with a switcher.
  --workspace-uri <url>      The workspace to deploy into, as its portal URL...
  --workspace-id <guid>      ...or its id.
  --vl-model <guid>          The ValueLens semantic model, instead of finding it by name.
                             Needed when several models match and there is no prompt.
  --cc-model <guid>          The Consumption Central semantic model, instead of finding it by name.
  --model-workspace-id <guid>  Where --vl-model / --cc-model live, when not the target workspace.
  --data-agent <guid>        A Fabric data agent in the target workspace for the Ask page.
  --tenant <guid>            Entra tenant, when your account spans several.
  --token <token>            A Fabric API token for finding the models (else FABRIC_TOKEN,
                             your rayfin login, then the Azure CLI).
  --dry-run, -n              Find the models and preview \`rayfin up\` without deploying.
  --yes, -y                  Accept rayfin's prompts. Several matching models then stop the
                             deploy instead of asking which to use.
`;

async function rayfinToken(tenant) {
    const helper = join(ROOT, "node_modules", "@microsoft", "rayfin-cli", "dist", "utils", "resolve-workspace-name.js");
    if (!existsSync(helper)) return undefined;
    try {
        const { acquireFabricTokenForLookup } = await import(pathToFileURL(helper).href);
        return (await acquireFabricTokenForLookup({ tenantId: tenant, interactive: false })) || undefined;
    } catch {
        return undefined;
    }
}

function azureCliToken(tenant) {
    const args = ["account", "get-access-token", "--resource", FABRIC_API, "--query", "accessToken", "-o", "tsv"];
    if (tenant) args.push("--tenant", tenant);
    const result = spawnSync("az", args, { encoding: "utf8", shell: process.platform === "win32" });
    const token = result.status === 0 ? result.stdout.trim() : "";
    return token || undefined;
}

async function fabricToken(options) {
    return options.token ?? process.env.FABRIC_TOKEN ?? (await rayfinToken(options.tenant)) ?? azureCliToken(options.tenant);
}

async function listSemanticModels(workspaceId, token) {
    const models = [];
    let url = `${FABRIC_API}/v1/workspaces/${workspaceId}/semanticModels`;
    while (url) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Listing the workspace's semantic models failed: ${response.status} ${response.statusText}.`);
        const body = await response.json();
        models.push(...(body.value ?? []));
        url = body.continuationUri ?? undefined;
    }
    return models;
}

async function findModels(options, workspaceId, products) {
    const overrides = { vl: options.vlModel, cc: options.ccModel };
    const modelWorkspace = options.modelWorkspaceId ?? workspaceId;
    const found = {};
    const missing = [];
    const toFind = [];
    for (const product of products) {
        if (overrides[product]) found[product] = { workspaceId: modelWorkspace, itemId: overrides[product] };
        else toFind.push(product);
    }
    if (toFind.length === 0) return { found, missing };

    const token = await fabricToken(options);
    if (!token) {
        throw new Error(
            "Couldn't get a Fabric API token to find the models. Run `npx rayfin login` or `az login`, " +
                `or pass ${toFind.map((product) => `--${product}-model <id>`).join(" and ")}.`,
        );
    }
    const models = await listSemanticModels(workspaceId, token);
    for (const product of toFind) {
        const { model: only, ambiguous } = pickModel(models, product);
        const { label } = MODEL_NAMES[product];
        let model = only;
        if (ambiguous) {
            if (options.yes || !process.stdin.isTTY) {
                throw new Error(
                    `Several ${label} models are in this workspace, so pass --${product}-model <id> to say which:\n` +
                        ambiguous.map((candidate) => `  ${candidate.displayName} (${candidate.id})`).join("\n"),
                );
            }
            model = await askWhichModel(label, ambiguous);
        }
        if (model) {
            found[product] = { workspaceId, itemId: model.id };
            console.log(`  ${label}: "${model.displayName}" (${model.id})`);
        } else {
            missing.push(product);
            console.log(`  ${label}: not in this workspace.`);
        }
    }
    return { found, missing };
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/** Puts `variant`'s deployment record in rayfin/ and returns a function that files it away again. */
function swapInState(variant, dryRun) {
    const rayfinDir = join(ROOT, "rayfin");
    const store = join(rayfinDir, ".variants", variant);
    const saved = new Map(STATE_FILES.map((file) => [file, existsSync(join(rayfinDir, file)) ? readFileSync(join(rayfinDir, file)) : undefined]));
    // `rayfin up` refreshes .env.local from the variant's record; local dev keeps its own.
    const envLocal = join(ROOT, ".env.local");
    const envLocalBefore = existsSync(envLocal) ? readFileSync(envLocal) : undefined;
    const ymlPath = join(rayfinDir, "rayfin.yml");
    const yml = readFileSync(ymlPath, "utf8");

    for (const file of STATE_FILES) {
        const kept = join(store, file);
        if (existsSync(kept)) copyFileSync(kept, join(rayfinDir, file));
        else rmSync(join(rayfinDir, file), { force: true });
    }
    writeFileSync(ymlPath, variantRayfinYml(yml, variant));

    return () => {
        if (!dryRun) {
            mkdirSync(store, { recursive: true });
            for (const file of STATE_FILES) {
                if (existsSync(join(rayfinDir, file))) copyFileSync(join(rayfinDir, file), join(store, file));
            }
        }
        for (const [file, content] of saved) {
            if (content === undefined) rmSync(join(rayfinDir, file), { force: true });
            else writeFileSync(join(rayfinDir, file), content);
        }
        writeFileSync(ymlPath, yml);
        if (envLocalBefore === undefined) rmSync(envLocal, { force: true });
        else writeFileSync(envLocal, envLocalBefore);
    };
}

/** Writes public/fabric.config.json and returns a function that puts back what was there. */
function writeConfig(config) {
    const path = join(ROOT, "public", "fabric.config.json");
    const before = existsSync(path) ? readFileSync(path) : undefined;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 4)}\n`);
    return () => {
        if (before === undefined) rmSync(path, { force: true });
        else writeFileSync(path, before);
    };
}

function runRayfinUp(options, workspaceId, variant) {
    const args = ["rayfin", "up", "--workspace-id", workspaceId];
    if (options.tenant) args.push("--tenant", options.tenant);
    if (options.dryRun) args.push("--dry-run");
    if (options.yes) args.push("--yes");
    console.log(`\n> npx ${args.join(" ")}`);
    const result = spawnSync("npx", args, {
        cwd: ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, VITE_APP_VARIANT: variant },
    });
    return result.status ?? 1;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(HELP);
        return 0;
    }
    const variant = options.variant?.trim().toLowerCase();
    if (!VARIANTS[variant]) throw new Error(`--variant must be vl, cc or both.\n\n${HELP}`);
    const workspaceId = options.workspaceId ?? workspaceIdFromUri(options.workspaceUri);
    if (!workspaceId || !GUID.test(workspaceId)) throw new Error("Pass the target workspace as --workspace-uri <url> or --workspace-id <guid>.");
    for (const [flag, id] of [["--vl-model", options.vlModel], ["--cc-model", options.ccModel], ["--model-workspace-id", options.modelWorkspaceId], ["--data-agent", options.dataAgent]]) {
        if (id !== undefined && !GUID.test(id)) throw new Error(`${flag} must be a GUID.`);
    }

    const { name, products } = VARIANTS[variant];
    console.log(`Deploying ${name} to workspace ${workspaceId}${options.dryRun ? " (dry run)" : ""}.\nFinding the semantic models:`);
    const { found, missing } = await findModels(options, workspaceId, products);
    if (Object.keys(found).length === 0 || (variant !== "both" && missing.length > 0)) {
        throw new Error(`${name} needs ${products.map((product) => MODEL_NAMES[product].label).join(" or ")} in the workspace, or its id.`);
    }
    if (missing.length > 0) {
        console.log(`  The app will show ${MODEL_NAMES[Object.keys(found)[0]].label} only until it is redeployed with both.`);
    }

    const existingPath = join(ROOT, "public", "fabric.config.json");
    const dataAgent = options.dataAgent ? { workspaceId, itemId: options.dataAgent } : undefined;
    const config = buildFabricConfig(readJson(existingPath), variant, found, dataAgent);
    console.log(`\npublic/fabric.config.json:\n${JSON.stringify(config, null, 4)}`);

    const restoreConfig = writeConfig(config);
    const restoreState = swapInState(variant, options.dryRun);
    try {
        return runRayfinUp(options, workspaceId, variant);
    } finally {
        restoreState();
        restoreConfig();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(`\n${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        },
    );
}
