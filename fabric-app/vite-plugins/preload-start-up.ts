//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { realpathSync } from "node:fs";
import path from "node:path";
import type { HtmlTagDescriptor, Plugin } from "vite";

/** The parts of an output chunk that {@link startUpChunks} reads. */
export interface Chunk {
    type: "chunk";
    fileName: string;
    facadeModuleId: string | null;
    imports: readonly string[];
}

/** A build's output files, keyed by file name. */
export type Bundle = Readonly<Record<string, Chunk | { type: "asset" }>>;

const posix = (file: string) => path.posix.normalize(file.replaceAll("\\", "/"));

/**
 * The chunks that `modules` need, in order and once each: the chunk that each
 * module starts, then every chunk it imports statically. Chunks that the
 * page's `entry` already loads are left out, and dynamic imports aren't
 * followed, so other lazy screens stay lazy. `modules` are paths from `root`,
 * the names Vite's build manifest gives them.
 */
export function startUpChunks(bundle: Bundle, entry: Chunk, root: string, modules: readonly string[]): string[] {
    const seen = new Set<string>();
    const files: string[] = [];
    const visit = (chunk: Chunk, preload: boolean) => {
        if (seen.has(chunk.fileName)) return;
        seen.add(chunk.fileName);
        if (preload) files.push(chunk.fileName);
        for (const fileName of chunk.imports) {
            const imported = bundle[fileName];
            if (imported?.type === "chunk") visit(imported, preload);
        }
    };
    visit(entry, false);
    for (const module of modules) {
        const name = posix(module);
        const chunk = Object.values(bundle).find(
            (candidate): candidate is Chunk =>
                candidate.type === "chunk" &&
                candidate.facadeModuleId !== null &&
                posix(path.relative(root, candidate.facadeModuleId)) === name,
        );
        if (!chunk) {
            throw new Error(
                `preload-start-up: no chunk starts at ${module}. List modules that the app loads with import(), ` +
                    "by their path from the project root, in vite.config.ts.",
            );
        }
        visit(chunk, true);
    }
    return files;
}

/**
 * The URL that the page at `page` (such as "/index.html") loads `fileName`
 * from, written the way Vite writes the page's own script and preload tags:
 * relative to the page for a relative `base`, and under `base` otherwise.
 */
export function builtUrl(fileName: string, base: string, page: string): string {
    if (base === "" || base === "./") {
        const depth = page.split("/").length - 2;
        return (depth > 0 ? "../".repeat(depth) : "./") + fileName;
    }
    return `${decodeURI(base).replace(/\/$/, "")}/${fileName}`;
}

/**
 * Adds a `<link rel="modulepreload">` to the built index.html for each chunk
 * that `modules` need (see {@link startUpChunks}). The browser downloads and
 * parses those chunks alongside the entry, rather than when the app imports
 * them, but doesn't run them: that still happens at the import. Vite's import
 * helper skips any chunk that a link on the page already preloads.
 */
export function preloadStartUp(modules: readonly string[]): Plugin {
    let root = "";
    let base = "/";
    return {
        name: "preload-start-up",
        apply: "build",
        configResolved(config) {
            // Vite names modules by their real paths, so a root reached through a
            // junction, a substituted drive or a short (8.3) name must be resolved too.
            try {
                root = realpathSync.native(config.root);
            } catch {
                root = config.root;
            }
            base = config.base;
        },
        transformIndexHtml: {
            order: "post",
            handler(_html, { path: page, bundle, chunk }): HtmlTagDescriptor[] | undefined {
                if (!bundle || !chunk) return undefined;
                return startUpChunks(bundle, chunk, root, modules).map((fileName) => ({
                    tag: "link",
                    attrs: { rel: "modulepreload", crossorigin: true, href: builtUrl(fileName, base, page) },
                    injectTo: "head",
                }));
            },
        },
    };
}
