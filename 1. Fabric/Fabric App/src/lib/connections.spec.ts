//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { availableDestinations } from "@/components/destinations";
import { isConnectionConfigured, type ModelReferences } from "./connections";

const WORKSPACE = "11111111-2222-3333-4444-555555555555";
const ITEM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("isConnectionConfigured", () => {
    it("accepts a model with both IDs set", () => {
        expect(isConnectionConfigured({ ae: { workspaceId: WORKSPACE, itemId: ITEM } }, "ae")).toBe(true);
    });

    it("treats a deleted block as not set up", () => {
        expect(isConnectionConfigured({ vl: { workspaceId: WORKSPACE, itemId: ITEM } }, "ae")).toBe(false);
    });

    it("treats the template's placeholders as not set up", () => {
        const models = {
            ae: { workspaceId: "<Agent Evaluator workspace ID>", itemId: "<Agent Evaluator semantic model ID>" },
        };
        expect(isConnectionConfigured(models, "ae")).toBe(false);
    });

    it("needs both IDs", () => {
        expect(isConnectionConfigured({ ae: { workspaceId: WORKSPACE, itemId: "" } }, "ae")).toBe(false);
        expect(isConnectionConfigured({ ae: { itemId: ITEM } }, "ae")).toBe(false);
    });
});

describe("availableDestinations", () => {
    const ids = (models: ModelReferences) => availableDestinations(models).map((destination) => destination.id);
    const valuelensOnly = { vl: { workspaceId: WORKSPACE, itemId: ITEM } };

    it("leaves out the pages whose model isn't set up", () => {
        expect(ids(valuelensOnly)).not.toContain("consumption");
        expect(ids(valuelensOnly)).not.toContain("agent-evaluation");
        expect(ids(valuelensOnly)).toContain("adoption");
        expect(ids(valuelensOnly)).toContain("appendix");
    });

    it("opens on the Executive summary, which needs only the ValueLens model", () => {
        expect(ids(valuelensOnly)[0]).toBe("executive");
    });

    it("shows each optional page once its model is set up", () => {
        const withEvaluator = { ...valuelensOnly, ae: { workspaceId: WORKSPACE, itemId: ITEM } };
        expect(ids(withEvaluator)).toContain("agent-evaluation");
        expect(ids(withEvaluator)).not.toContain("consumption");
    });
});
