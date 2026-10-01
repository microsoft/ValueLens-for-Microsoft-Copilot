//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// Text that went through a Windows-1252 round trip turns "—" into "â€”" and
// "£" into "Â£". Built from code points so this file does not match itself.
const MOJIBAKE = new RegExp(`[${String.fromCharCode(0xc3, 0xc2)}]|${String.fromCharCode(0xe2, 0x20ac)}`);

const sources = Object.entries(
    import.meta.glob<string>(["./**/*.{ts,tsx,dax,json,css}", "!./**/*.spec.ts"], {
        eager: true,
        query: "?raw",
        import: "default",
    }),
);

describe("source encoding", () => {
    it("finds the sources", () => {
        expect(sources.length).toBeGreaterThan(50);
    });

    it.each(sources)("%s has no double-encoded UTF-8", (_path, text) => {
        expect(text).not.toMatch(MOJIBAKE);
    });
});
