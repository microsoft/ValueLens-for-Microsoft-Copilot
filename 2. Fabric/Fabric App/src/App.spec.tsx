//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCssTheme } from "@microsoft/fabric-visuals";
import App from "@/App";
import { ThemeContext } from "@/hooks/theme.context";
import { useAppTheme } from "@/hooks/use-theme";

/** Mirrors the provider chain `main.tsx` mounts around the app. */
function Harness({ children }: { children: ReactNode }) {
    const { isDark, toggleTheme } = useAppTheme();
    const theme = useCssTheme();
    return (
        <ThemeContext.Provider value={{ isDark, toggleTheme, theme }}>{children}</ThemeContext.Provider>
    );
}

describe("App", () => {
    it("renders without throwing", () => {
        expect(() =>
            render(
                <Harness>
                    <App />
                </Harness>,
            ),
        ).not.toThrow();
    });

    it("mounts content into the document", () => {
        render(
            <Harness>
                <App />
            </Harness>,
        );
        expect(document.body).not.toBeEmptyDOMElement();
    });
});
