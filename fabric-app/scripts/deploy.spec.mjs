//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildFabricConfig, parseArgs, pickModel, VARIANTS, variantRayfinYml, workspaceIdFromUri } from "./deploy.mjs";

const model = (displayName, id = displayName) => ({ id, displayName });

describe("parseArgs", () => {
    it("reads values, inline values and flags", () => {
        expect(parseArgs(["--variant", "cc", "--workspace-id=abc", "-n", "--yes"])).toEqual({
            variant: "cc",
            workspaceId: "abc",
            dryRun: true,
            yes: true,
        });
    });

    it("rejects unknown options and missing values", () => {
        expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
        expect(() => parseArgs(["--variant"])).toThrow(/needs a value/);
        expect(() => parseArgs(["--variant", "--dry-run"])).toThrow(/needs a value/);
    });
});

describe("workspaceIdFromUri", () => {
    const id = "0A1B2C3D-0000-4000-8000-123456789ABC";

    it("finds the workspace in portal URLs", () => {
        expect(workspaceIdFromUri(`https://app.fabric.microsoft.com/groups/${id}/list?experience=fabric`)).toBe(id.toLowerCase());
        expect(workspaceIdFromUri(`https://app.powerbi.com/groups/${id}`)).toBe(id.toLowerCase());
    });

    it("is undefined without one", () => {
        expect(workspaceIdFromUri("https://app.fabric.microsoft.com/groups/me/list")).toBeUndefined();
        expect(workspaceIdFromUri(undefined)).toBeUndefined();
    });
});

describe("pickModel", () => {
    it("prefers the default names, in order", () => {
        const models = [model("ValueLens - Fabric"), model("Analytics Hub Model"), model("Analytics Hub Consumption Model")];
        expect(pickModel(models, "vl").model.displayName).toBe("Analytics Hub Model");
        expect(pickModel(models, "cc").model.displayName).toBe("Analytics Hub Consumption Model");
    });

    it("matches names case-insensitively", () => {
        expect(pickModel([model("consumption central - fabric")], "cc").model.displayName).toBe("consumption central - fabric");
    });

    it("takes a single model with a product prefix, such as an installer's renamed copy", () => {
        expect(pickModel([model("Analytics Hub Model 2")], "vl").model.displayName).toBe("Analytics Hub Model 2");
        expect(pickModel([model("Consumption Central (Contoso)")], "cc").model.displayName).toBe("Consumption Central (Contoso)");
    });

    it("doesn't take the consumption model for ValueLens", () => {
        expect(pickModel([model("ValueLens Consumption Model 2")], "vl")).toEqual({});
        expect(pickModel([model("ValueLens Consumption Model 2")], "cc").model.displayName).toBe("ValueLens Consumption Model 2");
    });

    it("reports two prefixed models as ambiguous", () => {
        expect(pickModel([model("ValueLens A"), model("ValueLens B")], "vl")).toEqual({ ambiguous: ["ValueLens A", "ValueLens B"] });
    });

    it("finds nothing in an unrelated workspace", () => {
        expect(pickModel([model("Sales")], "vl")).toEqual({});
        expect(pickModel([], "cc")).toEqual({});
    });
});

describe("buildFabricConfig", () => {
    const vl = { workspaceId: "w", itemId: "m" };

    it("keeps other keys, sets the variant and replaces the models", () => {
        const existing = { modules: { m365: true }, semanticModels: { cc: { workspaceId: "old", itemId: "old" } }, app: { other: 1 } };
        expect(buildFabricConfig(existing, "vl", { vl })).toEqual({
            modules: { m365: true },
            app: { other: 1, variant: "vl" },
            semanticModels: { vl },
        });
    });

    it("sets Ask only when a data agent is named", () => {
        const withAgent = buildFabricConfig({ ask: { workspaceId: "x", itemId: "y" } }, "both", { vl }, { workspaceId: "w", itemId: "a" });
        expect(withAgent.ask).toEqual({ workspaceId: "w", itemId: "a" });
        expect(buildFabricConfig({ ask: { workspaceId: "x", itemId: "y" } }, "both", { vl }).ask).toBeUndefined();
    });

    it("starts afresh from a missing or malformed config", () => {
        expect(buildFabricConfig(undefined, "cc", {})).toEqual({ app: { variant: "cc" }, semanticModels: {} });
        expect(buildFabricConfig([1], "cc", {})).toEqual({ app: { variant: "cc" }, semanticModels: {} });
    });
});

describe("variantRayfinYml", () => {
    const yml = "# A comment naming id: nothing\nid: valuelens-consumption-central\nname: ValueLens + Consumption Central\nversion: 1.0.0\n";

    it("swaps in each variant's item id and name, leaving the rest", () => {
        const out = variantRayfinYml(yml, "cc");
        expect(out).toContain("\nid: consumption-central-fabric-app\n");
        expect(out).toContain("\nname: Consumption Central\n");
        expect(out).toContain("# A comment naming id: nothing\n");
        expect(out).toContain("version: 1.0.0");
    });

    it("never uses the id an older app deploys under", () => {
        expect(Object.values(VARIANTS).map((variant) => variant.id)).not.toContain("valuelens");
        expect(new Set(Object.values(VARIANTS).map((variant) => variant.id)).size).toBe(3);
    });
});
