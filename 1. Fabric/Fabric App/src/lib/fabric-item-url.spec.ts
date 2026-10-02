//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fabricItemUrl } from "@/lib/fabric-item-url";

const ids = {
    workspaceId: "ws-1",
    itemId: "item-1",
    tenantId: "tenant-1",
};

describe("fabricItemUrl", () => {
    it("links to the app item on the build's portal, in the tenant it was deployed to", () => {
        expect(fabricItemUrl({
            ...ids,
            portalUrl: "https://app.fabric.microsoft.com/",
            hostname: "loyal-arch-1-westus3.webapp.fabricapps.net",
        })).toBe("https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1?ctid=tenant-1");
    });

    it("opens internal-ring apps on the internal portal", () => {
        expect(fabricItemUrl({
            ...ids,
            portalUrl: "https://app.fabric.microsoft.com",
            hostname: "calm-fawn-1-westcentralus.webapp.msit.fabricapps.net",
        })).toBe("https://msit.fabric.microsoft.com/groups/ws-1/appbackends/item-1?ctid=tenant-1");
    });

    it("keeps the portal's path and query, and leaves out an unknown tenant", () => {
        expect(fabricItemUrl({
            workspaceId: "ws 1",
            itemId: "item-1",
            portalUrl: "https://portal.example.com/fabric/?debug.useLocalManifests=1",
        })).toBe("https://portal.example.com/fabric/groups/ws%201/appbackends/item-1?debug.useLocalManifests=1");
    });

    it("has no link without the portal, workspace and item", () => {
        expect(fabricItemUrl({ ...ids, portalUrl: undefined })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "https://app.fabric.microsoft.com", workspaceId: "" })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "https://app.fabric.microsoft.com", itemId: undefined })).toBeNull();
        expect(fabricItemUrl({ ...ids, portalUrl: "not a url" })).toBeNull();
    });
});
