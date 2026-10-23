//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshnessLabel } from "./freshness-label";

const { useSourceFreshness, useLoadStatus } = vi.hoisted(() => ({ useSourceFreshness: vi.fn(), useLoadStatus: vi.fn() }));
vi.mock("@/hooks/use-source-freshness", () => ({ useSourceFreshness }));
vi.mock("@/hooks/use-load-status", () => ({ useLoadStatus }));

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

    it("reads any set of sources, as behind a report pack", () => {
        useSourceFreshness.mockReturnValue({ auditLog: "2026-10-07T00:00:00", cowork: "2026-09-28T00:00:00" });
        render(<FreshnessLabel sources={["auditLog", "cowork"]} />);
        expect(useSourceFreshness).toHaveBeenCalledWith(["auditLog", "cowork"]);
        expect(screen.getByText("Data: Audit log to 7 Oct · Cowork to week of 28 Sept")).toBeInTheDocument();
    });

    it("uses dates already read rather than reading them again", () => {
        useSourceFreshness.mockReturnValue({});
        render(<FreshnessLabel sources={["auditLog"]} dates={{ auditLog: "2026-10-07T00:00:00" }} />);
        expect(useSourceFreshness).toHaveBeenCalledWith([]);
        expect(screen.getByText("Data: Audit log to 7 Oct")).toBeInTheDocument();
    });

    it("adds a line for each of the page's loads that failed or loaded with a warning, with its reason", () => {
        useSourceFreshness.mockReturnValue({ m365Activity: "2026-10-07T00:00:00" });
        useLoadStatus.mockReturnValue([
            { activity: "Run_M365_Activity_Ingester", source: "Microsoft 365 activity", status: "Warning", reason: "It ran, but found nothing to load in Sales." },
            { activity: "Run_Audit_Log_Ingester", source: "Copilot audit log", status: "Failed", reason: "It ran out of time." },
        ]);
        render(<FreshnessLabel destination="work-patterns" />);
        expect(useLoadStatus).toHaveBeenCalledWith(true);
        expect(screen.getByText("Data: Microsoft 365 activity to 7 Oct")).toBeInTheDocument();
        expect(screen.getByText("Microsoft 365 activity loaded with a warning: It ran, but found nothing to load in Sales.")).toBeInTheDocument();
        expect(screen.queryByText(/Copilot audit log/)).toBeNull();
    });

    it("says a load failed even before any date arrives, and asks nothing on a page with no sources", () => {
        useSourceFreshness.mockReturnValue({});
        useLoadStatus.mockReturnValue([{ activity: "Run_Audit_Log_Ingester", source: "Copilot audit log", status: "Failed" }]);
        render(<FreshnessLabel destination="executive" />);
        expect(screen.getByText("Copilot audit log failed")).toBeInTheDocument();
        render(<FreshnessLabel destination="assumptions" />);
        expect(useLoadStatus).toHaveBeenLastCalledWith(false);
    });
});
