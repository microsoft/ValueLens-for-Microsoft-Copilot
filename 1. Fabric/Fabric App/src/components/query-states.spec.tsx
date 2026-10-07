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
});
