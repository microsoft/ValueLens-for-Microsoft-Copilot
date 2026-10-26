//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceAvailabilityContext } from "@/hooks/source-availability.context";
import { ALL_UNKNOWN } from "@/lib/optional-sources";

const mocked = vi.hoisted(() => ({
    requirements: { status: "outdated" as const, missing: ["Agents 365[Owner account]", "Agents 365[Governance Flags]"] },
}));

vi.mock("@/hooks/use-model-requirements", () => ({
    useModelRequirementState: () => mocked.requirements,
}));

import { GovernanceScreen } from ".";

describe("GovernanceScreen", () => {
    it("shows update guidance before running Governance queries when the model is older than the app", () => {
        render(
            <SourceAvailabilityContext.Provider value={{ ...ALL_UNKNOWN, agentRegistry: "present", defender: "notConfigured" }}>
                <GovernanceScreen />
            </SourceAvailabilityContext.Provider>,
        );

        expect(screen.getByRole("heading", { name: "Governance" })).toBeTruthy();
        expect(screen.getByText("Update your install")).toBeTruthy();
        expect(screen.getByText(/Agents 365\[Owner account\]/)).toBeTruthy();
        expect(screen.queryByText("Connect the Agent 365 registry")).toBeNull();
        expect(screen.getByText("Defender isn't turned on")).toBeTruthy();
    });

    it("still shows Shadow AI when the registry isn't connected", () => {
        render(
            <SourceAvailabilityContext.Provider value={{ ...ALL_UNKNOWN, agentRegistry: "absent", defender: "absent" }}>
                <GovernanceScreen />
            </SourceAvailabilityContext.Provider>,
        );

        expect(screen.getByText("Connect the Agent 365 registry")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Shadow AI" })).toBeTruthy();
        expect(screen.getByText("Connect Microsoft Defender")).toBeTruthy();
    });
});
