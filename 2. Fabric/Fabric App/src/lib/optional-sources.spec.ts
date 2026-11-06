//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ALL_UNKNOWN, isAbsent, readSourceState } from "./optional-sources";

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
