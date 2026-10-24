//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { FabricClient, type FabricClientConfig, type IFabricApiProxy } from "@microsoft/fabric-app-data";
import { describe, expect, it, vi } from "vitest";
import { currentPriority, withPriority } from "./query-priority";
import { QueryScheduler, scheduledProxy } from "./query-scheduler";

function pendingProxy(): IFabricApiProxy {
    const never = () => new Promise<never>(() => {});
    return {
        semanticModel: { executeDax: vi.fn(never), executeDaxJson: vi.fn(never) },
        lakehouse: { executeSql: vi.fn(never) },
        warehouse: { executeSql: vi.fn(never) },
    } as unknown as IFabricApiProxy;
}

describe("withPriority", () => {
    it("sets the lane only while starting, even when starting throws", () => {
        expect(withPriority("low", currentPriority)).toBe("low");
        expect(currentPriority()).toBe("normal");
        expect(() =>
            withPriority("low", () => {
                throw new Error("boom");
            }),
        ).toThrow("boom");
        expect(currentPriority()).toBe("normal");
    });

    // The lane is read when the SDK calls the proxy; if a release of the SDK
    // awaited anything before that, a page fetched ahead would run in the front.
    it.each([undefined, "json"] as const)("reaches the scheduler through the SDK's query() (%s protocol)", (daxProtocol) => {
        const scheduler = new QueryScheduler();
        const client = new FabricClient({
            proxy: scheduledProxy(pendingProxy(), scheduler),
            semanticModels: { model: { workspaceId: "ws", itemId: "m" } },
            daxProtocol,
        } as FabricClientConfig);

        void withPriority("low", () => client.semanticModel("model").query("EVALUATE A"));
        expect(scheduler.activity()).toMatchObject({ foreground: 0, background: 1 });

        void client.semanticModel("model").query("EVALUATE B");
        expect(scheduler.activity()).toMatchObject({ foreground: 1, background: 1 });
    });
});
