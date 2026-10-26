//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// @vitest-environment node
// The plugin runs in Node at build time, and the last tests build a small app with Vite.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, type IndexHtmlTransformContext, type IndexHtmlTransformHook, type ResolvedConfig, type Rolldown } from "vite";
import { builtUrl, preloadStartUp, startUpChunks, type Bundle, type Chunk } from "./preload-start-up";

const ROOT = "/hub/app";

function chunk(fileName: string, imports: string[] = [], module?: string): Chunk {
    return { type: "chunk", fileName, facadeModuleId: module ? `${ROOT}/${module}` : null, imports };
}

// Shaped like the app's build: the root chunk imports the entry chunk and
// loads the screens and a locale lazily, and the screens import the root chunk.
const entry = chunk("assets/index.js", ["assets/runtime.js"], "index.html");
const bundle: Bundle = Object.fromEntries(
    [
        entry,
        chunk("assets/runtime.js"),
        {
            ...chunk("assets/root.js", ["assets/index.js", "assets/utils.js", "assets/theme.js"], "src/root.tsx"),
            dynamicImports: ["assets/executive.js", "assets/value.js", "assets/en.js"],
        },
        chunk("assets/utils.js", ["assets/runtime.js"]),
        chunk("assets/theme.js", ["assets/utils.js"]),
        chunk("assets/en.js", [], "node_modules/visuals/en.js"),
        chunk("assets/executive.js", ["assets/root.js", "assets/panels.js", "assets/utils.js"], "src/screens/executive/index.tsx"),
        chunk("assets/panels.js", ["assets/root.js"]),
        chunk("assets/value.js", ["assets/root.js", "assets/panels.js", "assets/charts.js"], "src/screens/value/index.tsx"),
        chunk("assets/charts.js"),
    ]
        .map((file): [string, Chunk | { type: "asset" }] => [file.fileName, file])
        .concat([["assets/index.css", { type: "asset" }]]),
);
const START_UP = ["src/root.tsx", "src/screens/executive/index.tsx"];

describe("startUpChunks", () => {
    it("lists the chunks each module needs, root first, once each", () => {
        expect(startUpChunks(bundle, entry, ROOT, START_UP)).toEqual([
            "assets/root.js",
            "assets/utils.js",
            "assets/theme.js",
            "assets/executive.js",
            "assets/panels.js",
        ]);
    });

    it("leaves out the entry's chunks, other screens and anything loaded lazily", () => {
        const files = startUpChunks(bundle, entry, ROOT, START_UP);
        for (const file of ["assets/index.js", "assets/runtime.js", "assets/value.js", "assets/charts.js", "assets/en.js", "assets/index.css"]) {
            expect(files).not.toContain(file);
        }
    });

    it("accepts paths that start with ./ or use backslashes", () => {
        expect(startUpChunks(bundle, entry, ROOT, ["./src/root.tsx", "src\\screens\\executive\\index.tsx"])).toEqual(
            startUpChunks(bundle, entry, ROOT, START_UP),
        );
    });

    it("fails the build for a module that no chunk starts at", () => {
        expect(() => startUpChunks(bundle, entry, ROOT, ["src/screens/missing/index.tsx"])).toThrow(
            /no chunk starts at src\/screens\/missing\/index\.tsx.*vite\.config\.ts/,
        );
    });
});

describe("builtUrl", () => {
    it("puts the file under an absolute base, as Vite does", () => {
        expect(builtUrl("assets/root.js", "/", "/index.html")).toBe("/assets/root.js");
        expect(builtUrl("assets/root.js", "/hub/", "/index.html")).toBe("/hub/assets/root.js");
        expect(builtUrl("assets/root.js", "/my%20hub/", "/index.html")).toBe("/my hub/assets/root.js");
        expect(builtUrl("assets/root.js", "https://cdn.example.com/hub/", "/index.html")).toBe(
            "https://cdn.example.com/hub/assets/root.js",
        );
    });

    it("makes the file relative to the page for a relative base", () => {
        expect(builtUrl("assets/root.js", "./", "/index.html")).toBe("./assets/root.js");
        expect(builtUrl("assets/root.js", "", "/index.html")).toBe("./assets/root.js");
        expect(builtUrl("assets/root.js", "./", "/nested/page.html")).toBe("../assets/root.js");
    });
});

describe("preloadStartUp", () => {
    // Runs the plugin's hooks the way Vite does for a built page.
    function transform(modules: string[], root: string, base: string, page: Bundle, entryChunk?: Chunk) {
        const plugin = preloadStartUp(modules);
        (plugin.configResolved as (config: Pick<ResolvedConfig, "root" | "base">) => void)({ root, base });
        const { handler } = plugin.transformIndexHtml as { handler: IndexHtmlTransformHook };
        const context = { path: "/index.html", filename: `${root}/index.html`, bundle: page, chunk: entryChunk };
        return handler.call({} as ThisParameterType<IndexHtmlTransformHook>, "<html></html>", context as IndexHtmlTransformContext);
    }

    it("only runs in builds, after Vite adds the page's own tags", () => {
        const plugin = preloadStartUp(START_UP);
        expect(plugin.apply).toBe("build");
        expect(plugin.transformIndexHtml).toMatchObject({ order: "post" });
    });

    it("adds a modulepreload link to the head for each chunk", () => {
        expect(transform(["src/root.tsx"], ROOT, "/hub/", bundle, entry)).toEqual(
            ["root", "utils", "theme"].map((name) => ({
                tag: "link",
                attrs: { rel: "modulepreload", crossorigin: true, href: `/hub/assets/${name}.js` },
                injectTo: "head",
            })),
        );
    });

    it("adds nothing to a page without a module entry", () => {
        expect(transform(START_UP, ROOT, "/", bundle)).toBeUndefined();
    });

    it("finds the modules when the project is opened through a link to its folder", async () => {
        const real = await realpath(await mkdtemp(path.join(tmpdir(), "preload-start-up-")));
        const link = `${real}-link`;
        try {
            // A junction on Windows, which needs no extra rights; a symlink elsewhere.
            await symlink(real, link, "junction");
            const id = (file: string) => path.join(real, file).replaceAll("\\", "/");
            const page: Chunk = { type: "chunk", fileName: "assets/index.js", facadeModuleId: id("index.html"), imports: [] };
            const root: Chunk = { type: "chunk", fileName: "assets/root.js", facadeModuleId: id("src/root.tsx"), imports: [] };
            const tags = transform(["src/root.tsx"], link, "/", { [page.fileName]: page, [root.fileName]: root }, page);
            expect(tags).toMatchObject([{ attrs: { href: "/assets/root.js" } }]);
        } finally {
            await rm(link, { recursive: true, force: true });
            await rm(real, { recursive: true, force: true });
        }
    });

    describe("in a real build", () => {
        const FILES: Record<string, string> = {
            "index.html":
                '<!doctype html>\n<html>\n<head>\n<title>Fixture</title>\n</head>\n<body>\n<script type="module" src="/src/main.ts"></script>\n</body>\n</html>\n',
            "src/main.ts": 'import { log } from "./log";\nlog("main");\nvoid import("./root").then(({ start }) => start());\n',
            "src/log.ts": "export const log = (text: string) => console.log(text);\n",
            "src/format.ts": "export const format = (text: string) => `[${text}]`;\n",
            "src/root.ts": [
                'import { format } from "./format";',
                'import { log } from "./log";',
                "export async function start() {",
                '    log(format("root"));',
                '    const [{ home }, { other }] = await Promise.all([import("./screens/home"), import("./screens/other")]);',
                "    log(home().concat(other()).join());",
                "}",
                "",
            ].join("\n"),
            "src/screens/home.ts": 'import { format } from "../format";\nimport { table } from "./table";\nexport const home = () => table(format("home"));\n',
            "src/screens/other.ts": 'import { table } from "./table";\nexport const other = () => table("other");\n',
            "src/screens/table.ts": "export const table = (text: string) => [text];\n",
        };
        let root = "";

        beforeAll(async () => {
            // Vite names modules by their real paths, and the checks below compare against them.
            root = await realpath(await mkdtemp(path.join(tmpdir(), "preload-start-up-")));
            for (const [file, text] of Object.entries(FILES)) {
                await mkdir(path.dirname(path.join(root, file)), { recursive: true });
                await writeFile(path.join(root, file), text);
            }
        });

        afterAll(async () => {
            if (root) await rm(root, { recursive: true, force: true });
        });

        async function buildFixture(base: string) {
            const result = await build({
                root,
                base,
                configFile: false,
                envFile: false,
                publicDir: false,
                cacheDir: path.join(root, ".vite"),
                logLevel: "silent",
                build: { write: false, minify: false },
                plugins: [preloadStartUp(["src/root.ts", "src/screens/home.ts"])],
            });
            const files = (Array.isArray(result) ? result : [result]).flatMap((output) => ("output" in output ? output.output : []));
            const page = files.find((file): file is Rolldown.OutputAsset => file.fileName === "index.html");
            const chunks = files.filter((file): file is Rolldown.OutputChunk => file.type === "chunk");
            return { html: String(page?.source), chunks };
        }

        it.each(["/", "./"])(
            "links each chunk that the root and home screen need, once, after the entry script (base %j)",
            async (base) => {
                const { html, chunks } = await buildFixture(base);
                const links = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)];
                const hrefs = links.map(([, href]) => href);
                expect(new Set(hrefs).size).toBe(hrefs.length);
                const script = html.indexOf('<script type="module"');
                expect(script).toBeGreaterThan(-1);
                for (const link of links) expect(link.index).toBeGreaterThan(script);

                const prefix = base === "./" ? "./" : "/";
                const linked = hrefs.map((href) => {
                    expect(href.startsWith(prefix)).toBe(true);
                    return chunks.find(({ fileName }) => fileName === href.slice(prefix.length));
                });
                expect(linked).not.toContain(undefined);
                const modules = linked.flatMap((file) => file?.moduleIds ?? []).map((id) => path.relative(root, id).replaceAll("\\", "/"));
                expect(modules).toEqual(expect.arrayContaining(["src/root.ts", "src/format.ts", "src/screens/home.ts", "src/screens/table.ts"]));
                expect(modules).not.toContain("src/screens/other.ts");
                expect(modules).not.toContain("src/main.ts");
            },
            60_000,
        );
    });
});
