//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { availableDestinations } from "@/components/destinations";
import { isConnectionConfigured, isConnectionDeclared, type ModelReferences } from "./connections";
import { ALL_UNKNOWN, type SourceAvailability } from "./optional-sources";

const WORKSPACE = "11111111-2222-3333-4444-555555555555";
const ITEM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("isConnectionConfigured", () => {
    it("accepts a model with both IDs set", () => {
        expect(isConnectionConfigured({ cc: { workspaceId: WORKSPACE, itemId: ITEM } }, "cc")).toBe(true);
    });

    it("treats a deleted block as not set up", () => {
        expect(isConnectionConfigured({ vl: { workspaceId: WORKSPACE, itemId: ITEM } }, "cc")).toBe(false);
    });

    it("treats the template's placeholders as not set up", () => {
        const models = {
            cc: { workspaceId: "<Consumption Central workspace ID>", itemId: "<Consumption Central semantic model ID>" },
        };
        expect(isConnectionConfigured(models, "cc")).toBe(false);
    });

    it("needs both IDs", () => {
        expect(isConnectionConfigured({ cc: { workspaceId: WORKSPACE, itemId: "" } }, "cc")).toBe(false);
        expect(isConnectionConfigured({ cc: { itemId: ITEM } }, "cc")).toBe(false);
    });
});

describe("isConnectionDeclared", () => {
    it("is true once the config names the alias, set up or not", () => {
        expect(isConnectionDeclared({ vl: { workspaceId: WORKSPACE, itemId: ITEM } }, "vl")).toBe(true);
        expect(isConnectionDeclared({ cc: { workspaceId: "<Consumption Central workspace ID>" } }, "cc")).toBe(true);
        expect(isConnectionDeclared({ cc: {} }, "cc")).toBe(true);
    });

    it("is false for an alias the config leaves out", () => {
        expect(isConnectionDeclared({ vl: { workspaceId: WORKSPACE, itemId: ITEM } }, "cc")).toBe(false);
        expect(isConnectionDeclared({}, "vl")).toBe(false);
        expect(isConnectionDeclared({ cc: undefined }, "cc")).toBe(false);
    });
});

describe("availableDestinations", () => {
    const ids = (models: ModelReferences) => availableDestinations(models).map((destination) => destination.id);
    const valuelensOnly = { vl: { workspaceId: WORKSPACE, itemId: ITEM } };

    it("leaves out the pages whose model isn't set up", () => {
        expect(ids(valuelensOnly)).not.toContain("consumption");
        expect(ids(valuelensOnly)).toContain("adoption");
        expect(ids(valuelensOnly)).toContain("appendix");
    });

    it("opens on the Executive summary, which needs only the ValueLens model", () => {
        expect(ids(valuelensOnly)[0]).toBe("executive");
    });

    it("shows each optional page once its model is set up", () => {
        const withConsumption = { ...valuelensOnly, cc: { workspaceId: WORKSPACE, itemId: ITEM } };
        expect(ids(withConsumption)).toContain("consumption");
        expect(ids(withConsumption)).toContain("adoption");
    });

    it("leaves out a page only once its source is confirmed empty", () => {
        const withSources = (sources: SourceAvailability) =>
            availableDestinations(valuelensOnly, sources).map((destination) => destination.id);
        const empty = {
            m365Activity: "absent",
            productFeedback: "absent",
            agentRegistry: "absent",
            defender: "absent",
            resourceGraph: "absent",
        } as const;

        expect(withSources(empty)).not.toContain("feedback");
        expect(withSources(empty)).not.toContain("work-patterns");
        expect(withSources(empty)).toContain("leaderboards");
        expect(withSources({ ...empty, productFeedback: "present" })).toContain("feedback");
        expect(withSources({ ...empty, productFeedback: "checking" })).toContain("feedback");
        expect(withSources({ ...empty, productFeedback: "unknown" })).toContain("feedback");
        expect(withSources({ ...ALL_UNKNOWN, productFeedback: "notConfigured" })).not.toContain("feedback");
        expect(withSources(ALL_UNKNOWN)).toEqual(ids(valuelensOnly));
    });

    it("keeps Governance without a registry, so it can say how to connect one", () => {
        const noRegistry = { ...ALL_UNKNOWN, agentRegistry: "absent" } as const;
        expect(availableDestinations(valuelensOnly, noRegistry).map((destination) => destination.id)).toContain(
            "governance",
        );
    });
});
