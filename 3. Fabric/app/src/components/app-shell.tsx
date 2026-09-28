//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { useThemeContext } from "@/hooks/theme.context";
import { cn } from "@/lib/utils";
import { destinations, type DestinationId } from "./destinations";

interface AppShellProps {
    active: DestinationId;
    onNavigate: (id: DestinationId) => void;
    children: ReactNode;
}

/**
 * Sidebar-and-canvas frame. The sidebar is the whole navigation model — six
 * destinations replacing sixteen report pages and their bookmark bars.
 */
export function AppShell({ active, onNavigate, children }: AppShellProps) {
    const { isDark, toggleTheme } = useThemeContext();
    const current = destinations.find((destination) => destination.id === active);

    return (
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
            <nav
                aria-label="Sections"
                className="flex w-[248px] shrink-0 flex-col gap-500 border-r border-border bg-card px-400 py-500"
            >
                <div className="flex flex-col gap-100 px-200">
                    <span className="font-heading text-[length:var(--text-600)] leading-600">ValueLens</span>
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        for Microsoft Copilot
                    </span>
                </div>

                <ul className="flex flex-1 flex-col gap-100-nudge">
                    {destinations.map((destination) => {
                        const Icon = destination.icon;
                        const isActive = destination.id === active;
                        return (
                            <li key={destination.id}>
                                <button
                                    type="button"
                                    onClick={() => onNavigate(destination.id)}
                                    aria-current={isActive ? "page" : undefined}
                                    disabled={!destination.ready}
                                    className={cn(
                                        "flex w-full items-center gap-300 rounded-md px-300 py-200 text-left transition-colors",
                                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                        isActive
                                            ? "bg-accent text-accent-foreground"
                                            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                                        !destination.ready && "cursor-not-allowed opacity-50 hover:bg-transparent",
                                    )}
                                >
                                    <Icon className="icon-size-200 shrink-0" aria-hidden="true" />
                                    <span className="flex flex-col">
                                        <span className="text-[length:var(--text-300)] leading-300 font-medium">
                                            {destination.label}
                                        </span>
                                        <span className="text-[length:var(--text-100)] leading-100 opacity-70">
                                            {destination.ready ? destination.blurb : "Coming next"}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>

                <button
                    type="button"
                    onClick={toggleTheme}
                    aria-pressed={isDark}
                    className="flex items-center gap-300 rounded-md border border-border px-300 py-200 text-[length:var(--text-300)] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                    {isDark ? (
                        <Sun className="icon-size-200" aria-hidden="true" />
                    ) : (
                        <Moon className="icon-size-200" aria-hidden="true" />
                    )}
                    {isDark ? "Light mode" : "Dark mode"}
                </button>
            </nav>

            <main className="flex-1 overflow-y-auto">
                <div className="mx-auto flex max-w-[1400px] flex-col gap-700 px-700 py-600">
                    {current && (
                        <header className="flex flex-col gap-100">
                            <h1 className="font-heading text-[length:var(--text-hero-800)] leading-hero-800">
                                {current.label}
                            </h1>
                            <p className="text-[length:var(--text-400)] leading-400 text-muted-foreground">
                                {current.blurb}
                            </p>
                        </header>
                    )}
                    {children}
                </div>
            </main>
        </div>
    );
}
