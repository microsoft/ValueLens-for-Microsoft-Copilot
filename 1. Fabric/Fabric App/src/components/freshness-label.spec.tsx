//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshnessLabel } from "./freshness-label";

const { useSourceFreshness } = vi.hoisted(() => ({ useSourceFreshness: vi.fn() }));
vi.mock("@/hooks/use-source-freshness", () => ({ useSourceFreshness }));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("FreshnessLabel", () => {
    it("says how recent each of the page's sources is", () => {
        useSourceFreshness.mockReturnValue({ cowork: "2026-09-28T00:00:00", copilotStudio: "2026-10-06T00:00:00", azure: undefined });
        render(<FreshnessLabel destination="consumption" />);
        expect(useSourceFreshness).toHaveBeenCalledWith(["cowork", "copilotStudio", "azure"]);
        expect(screen.getByText("Data: Cowork to week of 28 Sept · Copilot Studio to 6 Oct")).toBeInTheDocument();
    });

    it("shows nothing while dates load, or when every query failed or came back blank", () => {
        useSourceFreshness.mockReturnValue({ auditLog: undefined });
        const { container } = render(<FreshnessLabel destination="executive" />);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows nothing on a page with no data of its own", () => {
        useSourceFreshness.mockReturnValue({ auditLog: "2026-10-07T00:00:00" });
        const { container } = render(<FreshnessLabel destination="assumptions" />);
        expect(container).toBeEmptyDOMElement();
    });
});
