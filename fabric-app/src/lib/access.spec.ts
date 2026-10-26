//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => ({ host: "fabric", rayfin: {}, semanticModels: {} }) }));
vi.mock("@/lib/fabric-item-url", () => ({ fabricItemUrl: () => "https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1" }));

import { accessRequestMailto, scopeRequestMailto } from "@/lib/access";

const access = { groupId: "group-1", groupName: "Analytics Hub viewers", contact: "admin@example.com" };

function body(mailto: string | null): string {
    return new URL(mailto ?? "").searchParams.get("body") ?? "";
}

describe("access request emails", () => {
    it("link to the app item on Fabric", () => {
        expect(body(accessRequestMailto(access))).toContain("so I can open https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1");
        expect(body(scopeRequestMailto(access))).toContain("I can open https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1 but");
    });

    it("need someone to send them to", () => {
        expect(accessRequestMailto({ groupId: "group-1" })).toBeNull();
        expect(scopeRequestMailto(undefined)).toBeNull();
    });
});
