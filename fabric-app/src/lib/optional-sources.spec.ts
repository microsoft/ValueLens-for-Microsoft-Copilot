//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    ALL_UNKNOWN,
    isAbsent,
    mergedSourceProbe,
    OPTIONAL_SOURCES,
    readMergedSourceState,
    readSourceState,
    SOURCE_PROBES,
} from "./optional-sources";

describe("mergedSourceProbe", () => {
    it("counts each source asked in one row, in a column named after it, as its own probe counts it", () => {
        const query = mergedSourceProbe(["resourceGraph", "m365Activity"]);
        expect(query).toBe(
            `EVALUATE ROW(\n    "m365Activity", COUNTROWS('M365 Activity'),\n    "resourceGraph", COUNTROWS('Agent Configuration') + COUNTROWS('Foundry Resources')\n)`,
        );
        for (const source of OPTIONAL_SOURCES) {
            const count = SOURCE_PROBES[source].replace(/^EVALUATE ROW\("Rows", (.*)\)$/, "$1");
            expect(mergedSourceProbe(OPTIONAL_SOURCES)).toContain(`"${source}", ${count}`);
        }
    });

    it("is empty when no source is asked", () => {
        expect(mergedSourceProbe([])).toBe("");
    });
});

describe("readMergedSourceState", () => {
    it("reads each source's count from its own column, as its own probe's row is read", () => {
        const row = { "[m365Activity]": 42, "[productFeedback]": 0, "[agentRegistry]": null, "[defender]": 3 };
        expect(readMergedSourceState(row, "m365Activity")).toBe("present");
        expect(readMergedSourceState(row, "productFeedback")).toBe("absent");
        expect(readMergedSourceState(row, "agentRegistry")).toBe("absent");
        expect(readMergedSourceState(row, "defender")).toBe("present");
        expect(readMergedSourceState(row, "resourceGraph")).toBe("absent");
        expect(readMergedSourceState(undefined, "defender")).toBe("absent");
    });
});

describe("readSourceState", () => {
    it("waits while the probe hasn't answered", () => {
        expect(readSourceState({ loaded: false })).toBe("checking");
    });

    it("finds a source with rows", () => {
        expect(readSourceState({ loaded: true, row: { "[Rows]": 42 } })).toBe("present");
    });

    it("treats no rows as absent", () => {
        expect(readSourceState({ loaded: true, row: { "[Rows]": 0 } })).toBe("absent");
        expect(readSourceState({ loaded: true, row: { "[Rows]": null } })).toBe("absent");
        expect(readSourceState({ loaded: true })).toBe("absent");
    });

    it("treats a table or measure the model doesn't have as absent", () => {
        expect(readSourceState({ loaded: true, error: "Cannot find table 'M365 Activity'." })).toBe("absent");
        expect(readSourceState({ loaded: true, error: "Failed to resolve name 'Agent Registry Records'." })).toBe("absent");
        expect(readSourceState({ loaded: true, error: "The column 'ProductFeedback'[Theme] was not found." })).toBe("absent");
    });

    it("hides nothing when the probe fails for another reason", () => {
        expect(readSourceState({ loaded: true, error: "The request timed out." })).toBe("unknown");
        expect(readSourceState({ loaded: false, error: "401 Unauthorized" })).toBe("unknown");
    });
});

describe("isAbsent", () => {
    it("is true only for a confirmed absence", () => {
        expect(isAbsent(ALL_UNKNOWN, "productFeedback")).toBe(false);
        expect(isAbsent({ ...ALL_UNKNOWN, productFeedback: "checking" }, "productFeedback")).toBe(false);
        expect(isAbsent({ ...ALL_UNKNOWN, productFeedback: "present" }, "productFeedback")).toBe(false);
        expect(isAbsent({ ...ALL_UNKNOWN, productFeedback: "absent" }, "productFeedback")).toBe(true);
        expect(isAbsent({ ...ALL_UNKNOWN, productFeedback: "notConfigured" }, "productFeedback")).toBe(true);
    });
});
