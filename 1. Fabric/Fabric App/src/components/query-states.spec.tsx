//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryError } from "./query-states";

describe("QueryError", () => {
    it("turns missing model columns into update guidance", () => {
        const message = "The column 'Agents 365'[Owner account] cannot be found or may not be used in this expression.";
        render(<QueryError message={message} />);

        expect(screen.getByText("Update your install")).toBeTruthy();
        expect(screen.getByText(/Agents 365\[Owner account\]/)).toBeTruthy();
        expect(screen.getByText(message)).toBeTruthy();
    });

    it("says the data isn't loaded yet when the model was never refreshed", () => {
        const message =
            "Column 'Chat + Agent Interactions (Audit Logs)'[Is Usage Row] does not hold any data because it needs to be recalculated or refreshed.";
        render(<QueryError message={message} />);

        expect(screen.getByText("Data not loaded yet")).toBeTruthy();
        expect(screen.getByText(/choose\s+Repair or change/)).toBeTruthy();
        expect(screen.queryByText("This didn't load")).toBeNull();
        expect(screen.queryByText("Update your install")).toBeNull();
    });
});
