//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { governanceExposure, governanceOwners, governanceReviewQueue, governanceSummary } from "@/queries/governance";
import {
    MODEL_REQUIREMENTS,
    readRequirementProbeState,
    requirementProbeDax,
} from "./model-requirements";

const governance = MODEL_REQUIREMENTS.governance[0]!;

describe("model requirements", () => {
    it("builds a zero-row probe over every required Governance column", () => {
        expect(requirementProbeDax(governance)).toBe(
            `EVALUATE TOPN(0, SELECTCOLUMNS('Agents 365', "Owner account", 'Agents 365'[Owner account], "Governance Flags", 'Agents 365'[Governance Flags], "Data Access", 'Agents 365'[Data Access], "Sharing Scope", 'Agents 365'[Sharing Scope]))`,
        );
    });

    it("classifies missing model objects without blocking unrelated errors", () => {
        expect(readRequirementProbeState(governance, { loaded: false })).toEqual({ status: "checking" });
        expect(readRequirementProbeState(governance, { loaded: true })).toEqual({ status: "ok" });
        expect(
            readRequirementProbeState(governance, {
                loaded: false,
                error: "The column 'Agents 365'[Owner account] cannot be found or may not be used in this expression.",
            }),
        ).toEqual({ status: "outdated", missing: ["Agents 365[Owner account]"] });
        expect(
            readRequirementProbeState(governance, {
                loaded: false,
                error: "Cannot find table 'Agents 365'.",
            }),
        ).toEqual({ status: "outdated", missing: ["Agents 365 table"] });
        expect(readRequirementProbeState(governance, { loaded: false, error: "The request timed out." })).toEqual({
            status: "unknown",
        });
    });

    it("keeps the Governance registry aligned with the shipped Governance DAX", () => {
        const dax = [
            governanceSummary().query,
            governanceExposure().query,
            governanceOwners().query,
            governanceReviewQueue().query,
        ].join("\n");

        for (const column of governance.columns) {
            expect(dax).toContain(`'Agents 365'[${column}]`);
        }
    });
});
