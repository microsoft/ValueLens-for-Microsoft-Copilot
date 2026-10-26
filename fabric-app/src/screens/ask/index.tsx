//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Send } from "lucide-react";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { Section } from "@/components/section";
import { availableDestinations, destinations, stageAnchor } from "@/components/destinations";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { askQuestion, AskError, type AskReply, type AskRun, type AskTurn } from "@/lib/ask-api";
import { dataAgentUrl } from "@/lib/fabric-item-url";
import { runtimeConfig, type AskConfig, type RuntimeHost } from "@/lib/runtime-config";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { runSummary, suggestedPages, type SuggestedPage } from "./ask-helpers";

const QUESTION_MAX = 1000;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const BUTTON = cn(
    SMALL,
    FOCUS,
    "inline-flex items-center justify-center gap-200 rounded-md border border-border px-300 py-100 transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60",
);
const PRIMARY = cn(
    SMALL,
    FOCUS,
    "inline-flex items-center justify-center gap-200 rounded-md bg-primary px-300 py-100 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60",
);

/**
 * Questions about the data in plain words. On Azure the app's own `/api/ask`
 * answers them inline from the same named queries the pages run, with the
 * viewer's own access. On Fabric a data agent (`--data-agent` at deploy) answers them in
 * Fabric, and this page suggests questions to take there. Without either it
 * still suggests questions and says how to turn Ask on.
 */
export function AskScreen() {
    const config = runtimeConfig();
    const sources = useSourceAvailability();
    const pages = useMemo(
        () => suggestedPages(availableDestinations(config.semanticModels, sources)),
        [config.semanticModels, sources],
    );

    return (
        <div className="flex flex-col gap-800">
            <Section id={stageAnchor("ask")} title="Ask" description={describe(config.ask, config.host)}>
                {config.ask?.mode === "chat" ? (
                    <AskChat pages={pages} />
                ) : config.ask?.mode === "fabric" ? (
                    <FabricAsk agent={config.ask} pages={pages} />
                ) : (
                    <AskSetup host={config.host} pages={pages} />
                )}
            </Section>
        </div>
    );
}

function describe(ask: AskConfig | undefined, host: RuntimeHost): string {
    if (ask?.mode === "chat")
        return "Ask a question about the data. Answers come only from the queries behind this app's pages, run with your own access, and show the queries used.";
    if (ask?.mode === "fabric")
        return "The data agent in Fabric answers questions about the data from the same models as this app, with your own access.";
    return host === "azure"
        ? "Ask isn't turned on for this install yet. These are the kinds of questions it answers."
        : "There's no data agent for this app yet. These are the kinds of questions it answers.";
}

function GroupedQuestions({ pages, children }: { pages: SuggestedPage[]; children: (question: string) => ReactNode }) {
    if (pages.length === 0) return null;
    return (
        <div className="grid gap-500 md:grid-cols-2">
            {pages.map((page) => (
                <section key={page.destination} aria-label={`${page.label} questions`} className="flex flex-col gap-200">
                    <h3 className={cn(SMALL, "font-semibold text-muted-foreground")}>{page.label}</h3>
                    <ul className="flex flex-col gap-100">
                        {page.questions.map((question) => (
                            <li key={question}>{children(question)}</li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

/** Suggested questions that copy themselves to the clipboard, to paste into the data agent. */
function CopyQuestions({ pages }: { pages: SuggestedPage[] }) {
    const [copied, setCopied] = useState<string>();
    const [failed, setFailed] = useState(false);
    const copy = async (question: string) => {
        try {
            await navigator.clipboard.writeText(question);
            setCopied(question);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    };
    return (
        <div className="flex flex-col gap-300">
            {failed && (
                <p role="alert" className={cn(SMALL, "text-destructive")}>
                    The browser wouldn't copy. Select the question and copy it instead.
                </p>
            )}
            <GroupedQuestions pages={pages}>
                {(question) => (
                    <button
                        type="button"
                        onClick={() => void copy(question)}
                        aria-label={`Copy: ${question}`}
                        className={cn(
                            BODY,
                            FOCUS,
                            "group flex w-full items-start gap-200 rounded-md px-200 py-100 text-left transition-colors hover:bg-secondary",
                        )}
                    >
                        <span className="flex-1">{question}</span>
                        {copied === question ? (
                            <span className={cn(SMALL, "flex shrink-0 items-center gap-100 text-primary")}>
                                <Check className="icon-size-100" aria-hidden="true" />
                                Copied
                            </span>
                        ) : (
                            <Copy
                                className="icon-size-100 mt-100 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                                aria-hidden="true"
                            />
                        )}
                    </button>
                )}
            </GroupedQuestions>
        </div>
    );
}

function FabricAsk({ agent, pages }: { agent: { workspaceId: string; itemId: string }; pages: SuggestedPage[] }) {
    const link = dataAgentUrl(agent);
    return (
        <div className="flex flex-col gap-600">
            <div className="flex flex-col gap-300 rounded-md border border-border bg-card p-400">
                <p className={BODY}>
                    Pick a question below to copy it, then paste it into the data agent. Every figure it gives comes
                    from the same semantic models, and it says when a source has no data.
                </p>
                {link && (
                    <a href={link} target="_blank" rel="noreferrer" className={cn(PRIMARY, "w-fit")}>
                        Open the data agent in Fabric
                        <ExternalLink className="icon-size-100" aria-hidden="true" />
                    </a>
                )}
                <p className={cn(SMALL, "text-muted-foreground")}>
                    To ask from Teams or Microsoft 365 Copilot instead, the data agent's owner can publish it there from
                    the agent's Publish settings in Fabric.
                </p>
            </div>
            <CopyQuestions pages={pages} />
        </div>
    );
}

function AskSetup({ host, pages }: { host: RuntimeHost; pages: SuggestedPage[] }) {
    return (
        <div className="flex flex-col gap-600">
            <div className="flex flex-col gap-200 rounded-md border border-border bg-card p-400">
                <h3 className={cn(BODY, "font-semibold")}>Turning Ask on</h3>
                <p className={cn(SMALL, "text-muted-foreground")}>
                    {host === "azure"
                        ? "An admin re-runs the installer and turns Ask on. It adds an Azure OpenAI model for the app, or uses one you already have, and answers with each viewer's own access to the data."
                        : "An admin creates a Fabric data agent over the semantic models and redeploys the app with it (scripts/deploy.mjs --data-agent). Data agents need a paid Fabric capacity (F2 or larger, or Power BI Premium) and the tenant settings for Copilot and data agents turned on."}
                </p>
            </div>
            <CopyQuestions pages={pages} />
        </div>
    );
}

interface Exchange {
    id: number;
    question: string;
    reply?: AskReply;
    error?: string;
}

function AskChat({ pages }: { pages: SuggestedPage[] }) {
    const [exchanges, setExchanges] = useState<Exchange[]>([]);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const nextId = useRef(0);
    const inputId = useId();

    const send = async (text: string) => {
        const question = text.trim();
        if (!question || busy) return;
        const history: AskTurn[] = exchanges.flatMap((exchange): AskTurn[] =>
            exchange.reply
                ? [
                      { role: "user", content: exchange.question },
                      { role: "assistant", content: exchange.reply.answer },
                  ]
                : [],
        );
        const id = nextId.current++;
        const settle = (patch: Partial<Exchange>) =>
            setExchanges((current) => current.map((exchange) => (exchange.id === id ? { ...exchange, ...patch } : exchange)));
        setExchanges((current) => [...current, { id, question }]);
        setDraft("");
        setBusy(true);
        try {
            settle({ reply: await askQuestion(question, history) });
        } catch (error) {
            settle({ error: errorMessage(error) });
        } finally {
            setBusy(false);
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        void send(draft);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(draft);
        }
    };

    return (
        <div className="flex flex-col gap-600">
            {exchanges.length > 0 && (
                <ol aria-label="Conversation" aria-live="polite" className="flex flex-col gap-500">
                    {exchanges.map((exchange) => (
                        <li key={exchange.id} className="flex flex-col gap-200">
                            <p className={cn(BODY, "w-fit max-w-[68ch] self-end rounded-md bg-accent px-300 py-200 text-accent-foreground")}>
                                {exchange.question}
                            </p>
                            {exchange.reply ? (
                                <Answer reply={exchange.reply} />
                            ) : exchange.error ? (
                                <p role="alert" className={cn(BODY, "text-destructive")}>{exchange.error}</p>
                            ) : (
                                <p className={cn(SMALL, "text-muted-foreground")}>Working it out…</p>
                            )}
                        </li>
                    ))}
                </ol>
            )}

            <form onSubmit={submit} className="flex flex-col gap-200">
                <label htmlFor={inputId} className={cn(SMALL, "font-semibold")}>Your question</label>
                <textarea
                    id={inputId}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    maxLength={QUESTION_MAX}
                    rows={2}
                    placeholder="Which orgs have the lowest activation?"
                    className={cn(BODY, FOCUS, "w-full resize-y rounded-md border border-border bg-background px-300 py-200")}
                />
                <div className="flex flex-wrap items-center justify-between gap-300">
                    <p className={cn(SMALL, "text-muted-foreground")}>
                        Ask can get things wrong. Check a figure on the page it comes from before you share it.
                    </p>
                    <div className="flex gap-200">
                        {exchanges.length > 0 && (
                            <button type="button" onClick={() => setExchanges([])} disabled={busy} className={BUTTON}>
                                Start over
                            </button>
                        )}
                        <button type="submit" disabled={busy || !draft.trim()} className={PRIMARY}>
                            <Send className="icon-size-100" aria-hidden="true" />
                            Ask
                        </button>
                    </div>
                </div>
            </form>

            <div className="flex flex-col gap-300">
                <h3 className={cn(BODY, "font-semibold")}>Suggested questions</h3>
                <GroupedQuestions pages={pages}>
                    {(question) => (
                        <button
                            type="button"
                            onClick={() => void send(question)}
                            disabled={busy}
                            className={cn(
                                BODY,
                                FOCUS,
                                "w-full rounded-md px-200 py-100 text-left text-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60",
                            )}
                        >
                            {question}
                        </button>
                    )}
                </GroupedQuestions>
            </div>
        </div>
    );
}

function errorMessage(error: unknown): string {
    if (error instanceof AskError) {
        if (error.status === 429 && error.retryAfter && !/try again/i.test(error.message))
            return `${error.message} Try again in ${waitText(error.retryAfter)}.`;
        return error.message;
    }
    return error instanceof Error ? error.message : "Ask couldn't answer that.";
}

function waitText(seconds: number): string {
    return seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

function Answer({ reply }: { reply: AskReply }) {
    return (
        <div className="flex max-w-[76ch] flex-col gap-200">
            <p className={cn(BODY, "whitespace-pre-wrap")}>{reply.answer}</p>
            {reply.runs.length > 0 && (
                <details className="rounded-md border border-border">
                    <summary className={cn(SMALL, "cursor-pointer px-300 py-200 text-muted-foreground hover:text-foreground")}>
                        {reply.runs.length === 1 ? "The query behind this answer" : `The ${reply.runs.length} queries behind this answer`}
                    </summary>
                    <ul className="flex flex-col gap-300 border-t border-border px-300 py-300">
                        {reply.runs.map((run, index) => (
                            <Run key={`${run.name}-${index}`} run={run} />
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

function Run({ run }: { run: AskRun }) {
    const page = destinations.find((destination) => destination.id === run.page);
    return (
        <li className="flex flex-col gap-100">
            <span className={cn(SMALL, "font-semibold")}>{run.description}</span>
            <span className={cn(SMALL, "text-muted-foreground")}>{runSummary(run)}</span>
            {page && <OpenDestinationLink destination={page.id}>See it on {page.label}</OpenDestinationLink>}
            <details>
                <summary className={cn(SMALL, "cursor-pointer text-muted-foreground hover:text-foreground")}>DAX</summary>
                <pre className="mt-100 max-h-[240px] overflow-auto rounded-md bg-secondary p-200 text-[length:var(--text-100)] leading-100">
                    {run.dax}
                </pre>
            </details>
        </li>
    );
}

