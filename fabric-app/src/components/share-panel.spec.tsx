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
        { groupId: string; groupName?: string; contact?: string; requestUrl?: string; rlsOrgAttribute?: string; appShared?: boolean } | undefined,
}));

const api = vi.hoisted(() => ({
    loadAccess: vi.fn(),
    addViewer: vi.fn(),
    removeViewer: vi.fn(),
    loadDelegations: vi.fn(),
    addDelegation: vi.fn(),
    removeDelegation: vi.fn(),
    approveDelegation: vi.fn(),
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

        expect(screen.getByText(/To give someone access, add them to/)).toHaveTextContent("To give someone access, add them to Analytics Hub Viewers.");
        expect(screen.getByRole("link", { name: "Add members in My Groups" }))
            .toHaveAttribute("href", "https://myaccount.microsoft.com/groups/group-1");
        expect(screen.getByText("Access requests go to admin@example.com.")).toBeInTheDocument();
        expect(api.loadAccess).not.toHaveBeenCalled();
        expect(screen.queryByText(/choose what people see/)).not.toBeInTheDocument();
    });

    it("on Fabric, says the app item still has to be shared until the installer records it", () => {
        runtime.host = "fabric";
        openPanel();

        expect(screen.queryByText(/can open it/)).not.toBeInTheDocument();
        expect(screen.getByText(/has to be shared with Analytics Hub Viewers once/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open the app item in Fabric" }))
            .toHaveAttribute("href", "https://app.fabric.microsoft.com/groups/ws-1/appbackends/item-1");
    });

    it("on Fabric, says anyone in the group can open it once it's shared", () => {
        runtime.host = "fabric";
        runtime.access = { groupId: "group-1", groupName: "Analytics Hub Viewers", requestUrl: "https://example.com/ask", appShared: true };
        openPanel();

        expect(screen.getByText(/can open it/)).toHaveTextContent("Anyone in Analytics Hub Viewers can open it.");
        expect(screen.queryByText(/has to be shared/)).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open the app item in Fabric" })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Where people ask for access" })).toHaveAttribute("href", "https://example.com/ask");
        expect(screen.queryByText(/Access requests go to/)).not.toBeInTheDocument();
    });

    it("on Fabric without a viewer group, says to share the item", () => {
        runtime.host = "fabric";
        runtime.access = undefined;
        openPanel();

        expect(screen.getByText("Give people access by sharing the app item in Fabric.")).toBeInTheDocument();
    });

    it("tells viewers who can add people", async () => {
        api.loadAccess.mockResolvedValue({ group: { id: "group-1", name: "Analytics Hub Viewers" }, canManage: false });
        openPanel();

        expect(await screen.findByText(/Ask admin@example.com to add people/)).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Viewers" })).not.toBeInTheDocument();
        expect(api.loadDelegations).not.toHaveBeenCalled();
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

    describe("with org-scoped access", () => {
        const viewers = { group: { id: "group-1", name: "Analytics Hub Viewers" }, canManage: false };
        const pending = {
            id: "p-1", upn: "report@example.com", scope: { type: "hierarchy", value: "leader@example.com" }, canDelegate: false,
            grantedBy: "leader@example.com", status: "pending_group", note: "", createdAt: "2025-01-01T00:00:00",
        };
        const state = (me: { isAdmin: boolean; canDelegate: boolean }, extra: object = {}) => ({
            enabled: true, orgAttribute: "department",
            me: { upn: me.isAdmin ? "admin@example.com" : "leader@example.com", scopes: [], ...me },
            delegations: [], pending: [], ...extra,
        });

        beforeEach(() => {
            runtime.access = { groupId: "group-1", groupName: "Analytics Hub Viewers", contact: "admin@example.com", rlsOrgAttribute: "department" };
            api.loadAccess.mockResolvedValue(viewers);
        });

        it("tells Fabric users only an admin chooses what people see", () => {
            runtime.host = "fabric";
            openPanel();

            expect(screen.getByText("Only an admin of the app can choose what people see. Ask admin@example.com.")).toBeInTheDocument();
            expect(api.loadDelegations).not.toHaveBeenCalled();
        });

        it("tells people who can't delegate who to ask", async () => {
            api.loadDelegations.mockResolvedValue(state({ isAdmin: false, canDelegate: false }));
            openPanel();

            expect(await screen.findByText("Only an admin of the app can choose what people see. Ask admin@example.com.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Give access" })).not.toBeInTheDocument();
        });

        it("shows nothing more when the API says it's off", async () => {
            api.loadDelegations.mockResolvedValue({ enabled: false });
            openPanel();

            await waitFor(() => expect(api.loadDelegations).toHaveBeenCalled());
            expect(screen.queryByText(/choose what people see/)).not.toBeInTheDocument();
            expect(screen.queryByRole("region", { name: "What people see" })).not.toBeInTheDocument();
        });

        it("lets a leader give their org, which waits for an admin", async () => {
            api.loadDelegations.mockResolvedValueOnce(state({ isAdmin: false, canDelegate: true }))
                .mockResolvedValue(state({ isAdmin: false, canDelegate: true }, { delegations: [pending] }));
            api.addDelegation.mockResolvedValue({ delegation: pending });
            openPanel();

            expect(await screen.findByText(/Give someone the data for your org/)).toBeInTheDocument();
            expect(screen.queryByLabelText("What they see")).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Can share their org")).not.toBeInTheDocument();
            fireEvent.change(screen.getByLabelText("Person's work email"), { target: { value: " report@example.com " } });
            fireEvent.click(screen.getByRole("button", { name: "Give access" }));

            expect(await screen.findByRole("status")).toHaveTextContent("report@example.com is waiting for an admin");
            expect(api.addDelegation).toHaveBeenCalledWith({ upn: "report@example.com", scope: { type: "hierarchy" } });
            const list = await screen.findByRole("list", { name: "Given by you" });
            expect(list).toHaveTextContent("Sees people below leader@example.com");
            expect(list).toHaveTextContent("Waiting for an admin");
        });

        it("lets an admin give an org that can share, and approve what's waiting", async () => {
            api.loadDelegations.mockResolvedValue(state({ isAdmin: true, canDelegate: true }, { pending: [pending] }));
            api.addDelegation.mockResolvedValue({ delegation: { ...pending, status: "active" }, refresh: { status: "started", message: "Power BI is updating who sees what." } });
            api.approveDelegation.mockResolvedValue({ delegation: { ...pending, status: "active" }, refresh: { status: "queued", message: "Soon." } });
            openPanel();

            const waiting = await screen.findByRole("list", { name: "Waiting for an admin" });
            expect(waiting).toHaveTextContent("added by leader@example.com");
            fireEvent.click(screen.getByRole("button", { name: "Approve report@example.com" }));
            expect(await screen.findByRole("status")).toHaveTextContent("Approved report@example.com. Soon.");
            expect(api.approveDelegation).toHaveBeenCalledWith("p-1");

            fireEvent.change(screen.getByLabelText("Person's work email"), { target: { value: "hr@example.com" } });
            fireEvent.change(screen.getByLabelText("What they see"), { target: { value: "org" } });
            fireEvent.change(screen.getByLabelText("Org name (department)"), { target: { value: "Human Resources" } });
            fireEvent.click(screen.getByLabelText("Can share their org"));
            fireEvent.click(screen.getByRole("button", { name: "Give access" }));

            await waitFor(() => expect(api.addDelegation).toHaveBeenCalledWith({ upn: "hr@example.com", scope: { type: "org", value: "Human Resources" }, canDelegate: true }));
            expect(await screen.findByRole("status")).toHaveTextContent("Added. Power BI is updating who sees what.");
        });

        it("keeps the form when giving access fails", async () => {
            api.loadDelegations.mockResolvedValue(state({ isAdmin: false, canDelegate: true }));
            api.addDelegation.mockRejectedValue(new Error("They already have this scope."));
            openPanel();

            fireEvent.change(await screen.findByLabelText("Person's work email"), { target: { value: "report@example.com" } });
            fireEvent.click(screen.getByRole("button", { name: "Give access" }));

            expect(await screen.findByRole("alert")).toHaveTextContent("They already have this scope.");
            expect(screen.getByLabelText("Person's work email")).toHaveValue("report@example.com");
        });
    });
});
