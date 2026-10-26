//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { appName, parseAppVariant, scopeModels, toAppVariant } from "./app-variant";

const vl = { workspaceId: "w-vl", itemId: "i-vl" };
const cc = { workspaceId: "w-cc", itemId: "i-cc" };
const models = { vl, cc, other: { workspaceId: "w-x", itemId: "i-x" } };

describe("toAppVariant", () => {
    it("accepts each variant, ignoring case and surrounding space", () => {
        expect(toAppVariant("vl")).toBe("vl");
        expect(toAppVariant("cc")).toBe("cc");
        expect(toAppVariant("both")).toBe("both");
        expect(toAppVariant("  VL ")).toBe("vl");
        expect(toAppVariant("Both")).toBe("both");
    });

    it("rejects anything else", () => {
        expect(toAppVariant("valuelens")).toBeUndefined();
        expect(toAppVariant("")).toBeUndefined();
        expect(toAppVariant(undefined)).toBeUndefined();
        expect(toAppVariant(null)).toBeUndefined();
        expect(toAppVariant(1)).toBeUndefined();
        expect(toAppVariant(["vl"])).toBeUndefined();
    });
});

describe("appName", () => {
    it("names the app after the products it shows", () => {
        expect(appName("vl")).toBe("ValueLens");
        expect(appName("cc")).toBe("Consumption Central");
        expect(appName("both")).toBe("ValueLens + Consumption Central");
    });
});

describe("scopeModels", () => {
    it("keeps only the ValueLens model in a ValueLens-only app", () => {
        expect(scopeModels(models, "vl")).toEqual({ vl });
    });

    it("keeps only the Consumption Central model in a Consumption Central-only app", () => {
        expect(scopeModels(models, "cc")).toEqual({ cc });
    });

    it("keeps both models, and drops unknown aliases, when the app shows both", () => {
        expect(scopeModels(models, "both")).toEqual({ vl, cc });
    });

    it("leaves out a model the config doesn't name", () => {
        expect(scopeModels({ vl }, "both")).toEqual({ vl });
        expect(scopeModels({ vl }, "cc")).toEqual({});
    });
});

describe("parseAppVariant", () => {
    it("reads app.variant from a config body", () => {
        expect(parseAppVariant({ app: { variant: "cc" } })).toBe("cc");
        expect(parseAppVariant({ app: { variant: "Both" }, semanticModels: {} })).toBe("both");
    });

    it("ignores a variant it doesn't know", () => {
        expect(parseAppVariant({ app: { variant: "all" } })).toBeUndefined();
        expect(parseAppVariant({ app: { variant: 3 } })).toBeUndefined();
    });

    it("is undefined when the body doesn't say", () => {
        expect(parseAppVariant({})).toBeUndefined();
        expect(parseAppVariant({ app: {} })).toBeUndefined();
        expect(parseAppVariant({ app: null })).toBeUndefined();
        expect(parseAppVariant({ app: ["vl"] })).toBeUndefined();
        expect(parseAppVariant(null)).toBeUndefined();
        expect(parseAppVariant([])).toBeUndefined();
        expect(parseAppVariant("vl")).toBeUndefined();
    });
});
