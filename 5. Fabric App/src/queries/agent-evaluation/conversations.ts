//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { humanizeIdentifier, relabelColumn, withoutEmoji } from "@/lib/model-text";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { evaluatorConnection as connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import archetypesQuery from "./answer-archetypes.dax?raw";
import archetypesSpec from "./answer-archetypes.json";
import summaryQuery from "./conversations-summary.dax?raw";
import commentsQuery from "./feedback-comments.dax?raw";
import sourcesQuery from "./knowledge-sources.dax?raw";
import sourcesSpec from "./knowledge-sources.json";
import themeQuery from "./theme-outcomes.dax?raw";
import themeSpec from "./theme-outcomes.json";
import topicsQuery from "./topic-health.dax?raw";

const summaryColumns: ColumnMetadataMap = {
    "[Topics]": { name: "Topics", displayName: "Topics", format: FORMAT_WHOLE },
    "[Grounded Rate]": { name: "Grounded Rate", displayName: "Grounded in knowledge", format: FORMAT_PERCENT },
    "[Answered From Knowledge]": { name: "Answered From Knowledge", displayName: "Answered from knowledge", format: FORMAT_WHOLE },
    "[Citations]": { name: "Citations", displayName: "Citations", format: FORMAT_WHOLE },
    "[Knowledge Gap Rate]": { name: "Knowledge Gap Rate", displayName: "Searches with no answer", format: FORMAT_PERCENT },
    "[Knowledge Gap Conversations]": { name: "Knowledge Gap Conversations", displayName: "Conversations with a gap", format: FORMAT_WHOLE },
    "[Turns Per Conversation]": { name: "Turns Per Conversation", displayName: "Turns per conversation", format: FORMAT_RATE },
    "[Single Turn Rate]": { name: "Single Turn Rate", displayName: "Answered in one turn", format: FORMAT_PERCENT },
    "[Turns To Resolve]": { name: "Turns To Resolve", displayName: "Turns to resolve", format: FORMAT_RATE },
    "[Friction]": { name: "Friction", displayName: "Friction", format: FORMAT_RATE },
    "[Friction Read]": { name: "Friction Read", displayName: "Friction" },
    "[Theme Verdict]": { name: "Theme Verdict", displayName: "Themes" },
    "[Theme Coverage]": { name: "Theme Coverage", displayName: "Coverage" },
    "[Top Fix]": { name: "Top Fix", displayName: "Top fix" },
    "[Backlog Summary]": { name: "Backlog Summary", displayName: "Backlog" },
    "[Topic Insight]": { name: "Topic Insight", displayName: "Topics" },
    "[Knowledge Story]": { name: "Knowledge Story", displayName: "Knowledge" },
    "[Knowledge Gap Read]": { name: "Knowledge Gap Read", displayName: "Knowledge gaps" },
    "[Depth Read]": { name: "Depth Read", displayName: "Conversation depth" },
    "[Feedback Insight]": { name: "Feedback Insight", displayName: "Feedback" },
    "[CSAT Story]": { name: "CSAT Story", displayName: "Satisfaction" },
};

/** The stage's headline figures, with the model's reads on topics, knowledge and feedback. */
export function conversationsSummary() {
    return { connection, query: summaryQuery, columnMetadata: summaryColumns };
}

const themeColumns: ColumnMetadataMap = {
    "[Theme]": { name: "Theme", displayName: "Theme" },
    "[Outcome]": { name: "Outcome", displayName: "Ended" },
    "[Outcome Order]": { name: "Outcome Order", displayName: "Order", format: FORMAT_WHOLE },
    "[Conversations]": { name: "Conversations", displayName: "Conversations", format: FORMAT_WHOLE },
};

/** How conversations ended within each topic theme. */
export function themeOutcomes() {
    return { connection, query: themeQuery, columnMetadata: themeColumns, vegaLiteSpec: themeSpec as VisualizationSpec };
}

const THEME_COLUMN = "Agent PerformanceTopic Theme";
const TOPIC_COLUMN = "Agent PerformanceTopic (resolved)";

/** The grid's first column: the theme on group rows, the topic on leaf rows. */
export const TOPIC_LABEL_COLUMN = "Topic";
export const TOPIC_FIELDS = ["Conversations", "Resolved", "Failing", "Friction", "Knowledge Gaps", "Turns To Resolve", "CSAT"] as const;

const topicColumns: ColumnMetadataMap = {
    "Agent Performance[Topic Theme]": { name: THEME_COLUMN, displayName: "Theme" },
    "Agent Performance[Topic (resolved)]": { name: TOPIC_COLUMN, displayName: "Topic" },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Conversations]": { name: "Conversations", displayName: "Conversations", format: FORMAT_WHOLE },
    "[Resolved]": { name: "Resolved", displayName: "Resolved", format: FORMAT_PERCENT },
    "[Failing]": { name: "Failing", displayName: "Failing", format: FORMAT_WHOLE },
    "[Friction]": { name: "Friction", displayName: "Friction", format: FORMAT_RATE },
    "[Knowledge Gaps]": { name: "Knowledge Gaps", displayName: "Knowledge gaps", format: FORMAT_WHOLE },
    "[Turns To Resolve]": { name: "Turns To Resolve", displayName: "Turns to resolve", format: FORMAT_RATE },
    "[CSAT]": { name: "CSAT", displayName: "Satisfaction", format: FORMAT_PERCENT },
};

/** The report's topic health matrix: each theme, then its topics, the most failing first. */
export function topicHealth() {
    return { connection, query: topicsQuery, columnMetadata: topicColumns };
}

/** Themes holding their topics, with topic identifiers written as words. */
export function toTopicTree(table: DataTable): RollupTree {
    return toRollupTree(relabelColumn(table, TOPIC_COLUMN, humanizeIdentifier), {
        group: THEME_COLUMN,
        leaf: TOPIC_COLUMN,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: TOPIC_LABEL_COLUMN,
        fields: TOPIC_FIELDS,
        blankLabel: "(Not recorded)",
    });
}

const sourcesColumns: ColumnMetadataMap = {
    "[Source]": { name: "Source", displayName: "Source" },
    "[Citations]": { name: "Citations", displayName: "Citations", format: FORMAT_WHOLE },
};

/** The ten knowledge sources agents cited most. */
export function knowledgeSources() {
    return { connection, query: sourcesQuery, columnMetadata: sourcesColumns, vegaLiteSpec: sourcesSpec as VisualizationSpec };
}

const archetypesColumns: ColumnMetadataMap = {
    "[Archetype]": { name: "Archetype", displayName: "Answered by" },
    "[Conversations]": { name: "Conversations", displayName: "Conversations", format: FORMAT_WHOLE },
};

/** How each conversation was answered: from the organisation's content, the model alone, a hand-off, or an error. */
export function answerArchetypes() {
    return {
        connection,
        query: archetypesQuery,
        columnMetadata: archetypesColumns,
        vegaLiteSpec: archetypesSpec as VisualizationSpec,
    };
}

/** Archetype names without the model's emoji. */
export function readableArchetypes(table: DataTable): DataTable {
    return relabelColumn(table, "Archetype", withoutEmoji);
}

const commentsColumns: ColumnMetadataMap = {
    "[Comment]": { name: "Comment", displayName: "Comment" },
    "[Verdict]": { name: "Verdict", displayName: "Feedback" },
    "[Times]": { name: "Times", displayName: "Times", format: FORMAT_WHOLE },
};

/**
 * What people typed alongside a thumbs up or down, most repeated first. Only
 * the feedback comment: the page never shows what was said in a conversation.
 */
export function feedbackComments() {
    return { connection, query: commentsQuery, columnMetadata: commentsColumns };
}
