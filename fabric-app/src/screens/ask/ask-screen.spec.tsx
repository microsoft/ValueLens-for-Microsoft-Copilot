//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askCatalogue } from "@/ask/catalogue";
import { destinations } from "@/components/destinations";
import { AskError } from "@/lib/ask-api";
import type { AskConfig } from "@/lib/runtime-config";
import { runSummary, suggestedPages } from "./ask-helpers";
import { AskScreen } from "./index";

const runtime = vi.hoisted(() => ({
    host: "fabric" as "fabric" | "azure",
    ask: undefined as AskConfig | undefined,
}));

const api = vi.hoisted(() => ({ askQuestion: vi.fn() }));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({
        host: runtime.host,
        rayfin: {},
        semanticModels: { vl: { workspaceId: "11111111-1111-1111-1111-111111111111", itemId: "22222222-2222-2222-2222-222222222222" } },
        ask: runtime.ask,
    }),
}));

vi.mock("@/lib/fabric-item-url", () => ({
    dataAgentUrl: (agent: { workspaceId: string; itemId: string }) =>
        `https://app.fabric.microsoft.com/groups/${agent.workspaceId}/aiskills/${agent.itemId}?ctid=t-1`,
}));

vi.mock("@/lib/ask-api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ask-api")>()),
    askQuestion: api.askQuestion,
}));

const executiveQuestion = askCatalogue.pages.find((page) => page.destination === "executive")!.questions[0];

describe("suggestedPages", () => {
    it("suggests questions only for the pages the install shows, in their order", () => {
        const pages = suggestedPages([
            { id: "adoption", label: "Adoption" },
            { id: "executive", label: "Executive summary" },
            { id: "ask", label: "Ask" },
        ]);
        expect(pages.map((page) => page.destination)).toEqual(["adoption", "executive"]);
        expect(pages[1].questions).toContain(executiveQuestion);
    });
});

describe("runSummary", () => {
    const run = { name: "q", page: "adoption", description: "d", filters: {}, dax: "EVALUATE {1}" };

    it("says how many rows, what was left out, and the filters used", () => {
        expect(runSummary({ ...run, rowCount: 12, suppressed: 3, truncated: false, filters: { from: "2025-07-01", to: "9999-12-31", organizations: ["Finance", "Sales"] } }))
            .toBe(`12 rows · 3 left out for fewer than ${askCatalogue.minPeople} people · 2025-07-01 to the latest · Finance, Sales`);
    });

    it("reports a failed query", () => {
        expect(runSummary({ ...run, error: "No access." })).toBe("Failed: No access.");
    });
});

describe("AskScreen", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.host = "fabric";
        runtime.ask = undefined;
    });

    it("says how to turn Ask on, and still suggests questions to copy", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        render(<AskScreen />);

        expect(screen.getByText(/paid Fabric capacity \(F2 or larger/)).toBeTruthy();
        const executive = screen.getByRole("region", { name: "Executive summary questions" });
        fireEvent.click(within(executive).getByRole("button", { name: `Copy: ${executiveQuestion}` }));

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(executiveQuestion));
        expect(await within(executive).findByText("Copied")).toBeTruthy();
    });

    it("groups the suggested questions in menu order, not the catalogue's", () => {
        render(<AskScreen />);
        const groups = screen.getAllByRole("region", { name: / questions$/ }).map((group) => group.getAttribute("aria-label"));
        const menu = destinations.map((destination) => `${destination.label} questions`);
        expect(groups).toEqual(menu.filter((label) => groups.includes(label)));
        expect(groups.slice(0, 2)).toEqual(["Executive summary questions", "Adoption questions"]);
    });

    it("tells an Azure install without a model to turn Ask on in the installer", () => {
        runtime.host = "azure";
        render(<AskScreen />);
        expect(screen.getByText(/turns Ask on/)).toBeTruthy();
    });

    it("opens the data agent in Fabric", () => {
        runtime.ask = { mode: "fabric", workspaceId: "ws-2", itemId: "agent-1" };
        render(<AskScreen />);

        const link = screen.getByRole("link", { name: /Open the data agent in Fabric/ });
        expect(link.getAttribute("href")).toBe("https://app.fabric.microsoft.com/groups/ws-2/aiskills/agent-1?ctid=t-1");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(screen.getByText(/Microsoft 365 Copilot/)).toBeTruthy();
    });

    it("answers on Azure, shows the queries behind the answer, and sends the conversation so far", async () => {
        runtime.host = "azure";
        runtime.ask = { mode: "chat" };
        api.askQuestion.mockResolvedValueOnce({
            answer: "Active users rose 4% on last month.",
            runs: [{ name: "executive_kpis", page: "executive", description: "Headline figures", filters: {}, dax: "EVALUATE {1}", rowCount: 1, suppressed: 0, truncated: false }],
        });
        render(<AskScreen />);

        fireEvent.click(screen.getByRole("button", { name: executiveQuestion }));
        expect(api.askQuestion).toHaveBeenCalledWith(executiveQuestion, []);
        expect(await screen.findByText("Active users rose 4% on last month.")).toBeTruthy();
        expect(screen.getByText("The query behind this answer")).toBeTruthy();
        expect(screen.getByText("EVALUATE {1}")).toBeTruthy();

        api.askQuestion.mockResolvedValueOnce({ answer: "Finance.", runs: [] });
        fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Which org grew most?" } });
        fireEvent.click(screen.getByRole("button", { name: "Ask" }));

        await screen.findByText("Finance.");
        expect(api.askQuestion).toHaveBeenLastCalledWith("Which org grew most?", [
            { role: "user", content: executiveQuestion },
            { role: "assistant", content: "Active users rose 4% on last month." },
        ]);
    });

    it("says when to try again after hitting the limit", async () => {
        runtime.host = "azure";
        runtime.ask = { mode: "chat" };
        api.askQuestion.mockRejectedValueOnce(new AskError("You've asked a lot of questions in the last few minutes.", "AskRateLimited", 429, 120));
        render(<AskScreen />);

        fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "How many users?" } });
        fireEvent.submit(screen.getByLabelText("Your question").closest("form")!);

        expect((await screen.findByRole("alert")).textContent).toBe("You've asked a lot of questions in the last few minutes. Try again in 2 minutes.");
    });
});
