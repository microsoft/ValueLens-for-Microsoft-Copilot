//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTimesContext, type TaskTimesContextValue } from "@/hooks/task-times.context";
import { modelTaskTimes } from "@/queries/assumptions";
import taskRows from "@/queries/assumptions/__fixtures__/task-times.rows.json";
import hourRows from "@/queries/assumptions/__fixtures__/hours-per-minute.rows.json";
import { TimePerTaskStage } from "./time-per-task-stage";

function toTable(rows: readonly Record<string, unknown>[]) {
    const names = Object.keys(rows[0] ?? {});
    return { columns: names.map((name) => ({ name })), rows: rows.map((row) => names.map((name) => row[name])) };
}

vi.mock("@/hooks/use-filtered-query", () => ({
    useFilteredQuery: (config: { query: string }) => ({
        data: {
            status: "success",
            table: toTable(config.query === modelTaskTimes().query ? taskRows : hourRows),
        },
        isLoading: false,
        isRefreshing: false,
        refetch: () => undefined,
    }),
}));

const save = vi.fn<TaskTimesContextValue["save"]>();

function renderStage(value: Partial<TaskTimesContextValue> = {}) {
    render(
        <TaskTimesContext.Provider value={{ status: "ready", saved: [], save, ...value }}>
            <TimePerTaskStage />
        </TaskTimesContext.Provider>,
    );
}

const typical = (task: string) => screen.getByLabelText(`${task}, Typical minutes`) as HTMLInputElement;
const rowOf = (task: string) => typical(task).closest("tr") as HTMLTableRowElement;

describe("Time per task", () => {
    beforeEach(() => {
        save.mockReset().mockResolvedValue(undefined);
    });

    it("lists every task at the research, busiest first", () => {
        renderStage();
        const bodyRows = screen.getAllByRole("row").slice(1);
        expect(bodyRows).toHaveLength(taskRows.length);
        expect(within(bodyRows[0]).getByText("Document Drafting")).toBeTruthy();
        expect(typical("Email Drafting").value).toBe("8");
        expect(within(rowOf("Email Drafting")).getByText("117 h")).toBeTruthy();
        expect(within(rowOf("Email Drafting")).getByRole("link", { name: /opens in a new tab/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save for everyone" })).toBeNull();
    });

    it("shows what a typed time does to the hours, then saves it for everyone", async () => {
        renderStage();
        fireEvent.change(typical("Email Drafting"), { target: { value: "10" } });

        const row = rowOf("Email Drafting");
        expect(within(row).getByText("146 h")).toBeTruthy();
        expect(within(row).getByText("Research 117 h")).toBeTruthy();
        expect(within(row).getByText("Changed, not saved")).toBeTruthy();
        expect(screen.getByText("1 task changed, not saved yet.")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(save).toHaveBeenCalledWith([{ task: "Email Drafting", time: { low: 3, typical: 10, high: 12 } }]);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Save for everyone" })).toBeNull());
    });

    it("won't save times out of order", () => {
        renderStage();
        fireEvent.change(typical("Email Drafting"), { target: { value: "20" } });
        expect(within(rowOf("Email Drafting")).getByText(/Keep Conservative at or below Typical/)).toBeTruthy();
        expect(typical("Email Drafting").getAttribute("aria-invalid")).toBe("true");
        expect((screen.getByRole("button", { name: "Save for everyone" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("puts a typed change back with Escape, or all of them with Discard", () => {
        renderStage();
        fireEvent.change(typical("Email Drafting"), { target: { value: "10" } });
        fireEvent.keyDown(typical("Email Drafting"), { key: "Escape" });
        expect(typical("Email Drafting").value).toBe("8");

        fireEvent.change(typical("Teams Messaging"), { target: { value: "4" } });
        fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
        expect(screen.queryByText(/changed, not saved yet/)).toBeNull();
    });

    it("marks a task on its own times and puts the research back", async () => {
        renderStage({ saved: [{ task: "Email Drafting", low: 4, typical: 10, high: 14 }] });
        const row = rowOf("Email Drafting");
        expect(within(row).getByText("Your times")).toBeTruthy();
        expect(typical("Email Drafting").value).toBe("10");

        fireEvent.click(within(row).getByRole("button", { name: /Use research/ }));
        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        await waitFor(() => expect(save).toHaveBeenCalledWith([{ task: "Email Drafting", time: null }]));
    });

    it("tells the user why a save failed and keeps the change", async () => {
        save.mockRejectedValue(new Error("Forbidden"));
        renderStage();
        fireEvent.change(typical("Email Drafting"), { target: { value: "10" } });
        fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
        expect(await screen.findByText("Couldn't save: Forbidden")).toBeTruthy();
        expect(typical("Email Drafting").value).toBe("10");
    });

    it("locks the times when the app's database can't be reached", () => {
        renderStage({ status: "unavailable", unavailableReason: "Timed out." });
        expect(screen.getByText(/Saved times can't be read right now/)).toBeTruthy();
        expect(typical("Email Drafting").disabled).toBe(true);
    });

    it("finds a task by name", () => {
        renderStage();
        fireEvent.change(screen.getByPlaceholderText("Find a task"), { target: { value: "drafting" } });
        const names = screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent ?? "");
        expect(names.length).toBeGreaterThan(0);
        expect(names.every((name) => /drafting/i.test(name))).toBe(true);
    });
});
