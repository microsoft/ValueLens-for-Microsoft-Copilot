//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessScopeChip, NoScopeNotice } from "@/components/access-scope";

const runtime = vi.hoisted(() => ({
    access: { groupId: "group-1", contact: "admin@example.com" } as { groupId: string; contact?: string; requestUrl?: string } | undefined,
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: "azure", rayfin: {}, semanticModels: {}, access: runtime.access }),
}));

describe("AccessScopeChip", () => {
    it("renders nothing when org-scoped access is off", () => {
        const { container } = render(<AccessScopeChip state={{ kind: "off" }} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("says whose data is on screen", () => {
        render(<AccessScopeChip state={{ kind: "scoped", isDefault: false, scopes: [{ type: "hierarchy", value: "lead@example.com" }] }} />);
        expect(screen.getByText("Showing: people below lead@example.com")).toBeInTheDocument();
    });
});

describe("NoScopeNotice", () => {
    beforeEach(() => {
        runtime.access = { groupId: "group-1", contact: "admin@example.com" };
    });

    it("says who to ask", () => {
        render(<NoScopeNotice />);
        expect(screen.getByRole("heading", { name: "You don't have a scope yet" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "admin@example.com" }).getAttribute("href")).toMatch(/^mailto:admin%40example\.com\?subject=/);
    });

    it("falls back to an admin when no contact is set", () => {
        runtime.access = undefined;
        render(<NoScopeNotice />);
        expect(screen.getByText("Ask an admin of the app to give you a scope.")).toBeInTheDocument();
    });
});
