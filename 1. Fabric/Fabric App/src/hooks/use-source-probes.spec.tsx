//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
    calls: [] as string[],
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({
        modules: { m365Activity: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false },
    }),
}));

vi.mock("./use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query }: { query: string }) => {
        mocked.calls.push(query);
        return { data: { status: "success", table: { columns: [{ name: "[Rows]" }], rows: [[7]] } } };
    },
}));

import { SOURCE_PROBES } from "@/lib/optional-sources";
import { useSourceProbes } from "./use-source-probes";

describe("useSourceProbes", () => {
    // An install from before the Defender module says nothing about it, so it is probed and the data decides.
    it("marks modules the installer left off without probing them", () => {
        mocked.calls = [];
        const { result } = renderHook(() => useSourceProbes());

        expect(result.current).toEqual({
            m365Activity: "present",
            productFeedback: "notConfigured",
            agentRegistry: "notConfigured",
            defender: "present",
        });
        expect(mocked.calls).toEqual([SOURCE_PROBES.m365Activity, "", "", SOURCE_PROBES.defender]);
    });
});
