//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Check } from "lucide-react";
import { menuOptionClass } from "@/lib/menu-option";
import { FilterMenu } from "./filter-menu";

interface ChoiceMenuProps {
    label: string;
    /** The "everything" option, shown first and used when `value` is undefined. */
    allLabel: string;
    choices: readonly { value: string; label: string; count?: number }[];
    value: string | undefined;
    onChange: (value: string | undefined) => void;
}

/**
 * A single-choice dropdown in the filter bar's style, for narrowing a table
 * locally without touching the app-wide filters.
 */
export function ChoiceMenu({ label, allLabel, choices, value, onChange }: ChoiceMenuProps) {
    const summary = choices.find((choice) => choice.value === value)?.label ?? allLabel;
    const options = [{ value: undefined, label: allLabel, count: undefined }, ...choices];

    return (
        <FilterMenu label={label} summary={summary} active={value !== undefined} panelClassName="w-[300px]">
            {(close) => (
                <div className="flex flex-col gap-100">
                    {options.map((option) => {
                        const selected = option.value === value;
                        return (
                            <button
                                key={option.value ?? ""}
                                type="button"
                                aria-pressed={selected}
                                className={menuOptionClass(selected)}
                                onClick={() => {
                                    onChange(option.value);
                                    close();
                                }}
                            >
                                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                {option.count !== undefined && (
                                    <span className="tabular-nums text-muted-foreground">{option.count}</span>
                                )}
                                {selected && <Check className="icon-size-200 shrink-0" aria-hidden="true" />}
                            </button>
                        );
                    })}
                </div>
            )}
        </FilterMenu>
    );
}
