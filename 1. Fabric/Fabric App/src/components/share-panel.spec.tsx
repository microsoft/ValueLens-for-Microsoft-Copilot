//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SharePanel } from "@/components/share-panel";

const runtime = vi.hoisted(() => ({
    host: "azure" as "fabric" | "azure",
    access: { groupId: "group-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com" } as
        { groupId: string; groupName?: string; contact?: string } | undefined,
}));

const api = vi.hoisted(() => ({
    loadAccess: vi.fn(),
    addViewer: vi.fn(),
    removeViewer: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: runtime.host, rayfin: {}, semanticModels: {}, access: runtime.access }),
}));

vi.mock("@/lib/fabric-item-url", () => ({
    fabricItemUrl: () => "https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1",
}));

vi.mock("@/lib/access-api", () => api);

function openPanel() {
    render(<SharePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
}

describe("SharePanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.host = "azure";
        runtime.access = { groupId: "group-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com" };
    });

    it("copies the app link", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        api.loadAccess.mockResolvedValue({ group: { id: "group-1", name: "Analytics Hub Viewers" }, canManage: false });
        openPanel();

        fireEvent.click(screen.getByRole("button", { name: "Copy app link" }));

        expect(await screen.findByRole("button", { name: "Link copied" })).toBeInTheDocument();
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/`);
    });

    it("points Fabric users to My Groups", () => {
        runtime.host = "fabric";
        openPanel();

        expect(screen.getByRole("link", { name: "Add or remove people in My Groups" }))
            .toHaveAttribute("href", "https://myaccount.microsoft.com/groups/group-1");
        expect(api.loadAccess).not.toHaveBeenCalled();
    });

    it("tells viewers who can add people", async () => {
        api.loadAccess.mockResolvedValue({ group: { id: "group-1", name: "Analytics Hub Viewers" }, canManage: false });
        openPanel();

        expect(await screen.findByText(/Ask admin@example.com to add people/)).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Viewers" })).not.toBeInTheDocument();
    });

    it("lets managers add and remove viewers", async () => {
        api.loadAccess.mockResolvedValue({
            group: { id: "group-1", name: "Analytics Hub Viewers" },
            canManage: true,
            members: [{ id: "u-1", name: "Avery", email: "avery@example.com", kind: "user" }],
        });
        api.addViewer.mockResolvedValue({ id: "u-2", name: "Blake", email: "blake@example.com", kind: "user" });
        api.removeViewer.mockResolvedValue(undefined);
        openPanel();

        expect(await screen.findByText("Avery")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Add a person's email or a group's name"), { target: { value: " blake@example.com " } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Blake")).toBeInTheDocument();
        expect(api.addViewer).toHaveBeenCalledWith("blake@example.com");

        fireEvent.click(screen.getByRole("button", { name: "Remove Avery" }));
        await waitFor(() => expect(screen.queryByText("Avery")).not.toBeInTheDocument());
        expect(api.removeViewer).toHaveBeenCalledWith("u-1");
    });

    it("shows why an add failed", async () => {
        api.loadAccess.mockResolvedValue({ group: { id: "group-1", name: "Analytics Hub Viewers" }, canManage: true, members: [] });
        api.addViewer.mockRejectedValue(new Error("No user or group named nobody@example.com was found."));
        openPanel();

        fireEvent.change(await screen.findByLabelText("Add a person's email or a group's name"), { target: { value: "nobody@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("No user or group named nobody@example.com was found.");
    });
});
