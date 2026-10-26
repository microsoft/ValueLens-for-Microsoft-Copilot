//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";
import { forgetKeptResults, KEPT_RESULTS_DATABASE } from "@/lib/forget-kept-results";

const sources = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
>;

describe("forgetKeptResults", () => {
    it("deletes the results database a preview build kept, and nothing else", () => {
        const request = {} as IDBOpenDBRequest;
        const deleteDatabase = vi.fn(() => request);
        forgetKeptResults({ deleteDatabase } as unknown as IDBFactory);
        expect(deleteDatabase).toHaveBeenCalledTimes(1);
        expect(deleteDatabase).toHaveBeenCalledWith("analytics-hub-results");
        expect(KEPT_RESULTS_DATABASE).toBe("analytics-hub-results");
        expect(request.onerror).toBeTypeOf("function");
    });

    it("never throws where the page may not use IndexedDB", () => {
        expect(() => forgetKeptResults(undefined)).not.toThrow();
        const refusing = {
            deleteDatabase: () => {
                throw new DOMException("denied", "SecurityError");
            },
        } as unknown as IDBFactory;
        expect(() => forgetKeptResults(refusing)).not.toThrow();
    });

    it("runs as the app starts", () => {
        expect(sources["/src/main.tsx"]).toMatch(/forgetKeptResults\(\);/);
    });

    it("leaves no code that writes query results to the device", () => {
        const writers = Object.entries(sources)
            .filter(([path]) => !path.endsWith(".spec.ts") && !path.endsWith(".spec.tsx"))
            .filter(([, source]) => /indexedDB\.open|\.objectStore\(|createObjectStore|caches\.open/.test(source))
            .map(([path]) => path);
        expect(writers).toEqual([]);
    });
});
