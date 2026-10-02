//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** A semantic model reference as `fabric.yaml` declares it. */
export interface ModelReference {
    workspaceId?: string;
    itemId?: string;
}

export type ModelReferences = Readonly<Record<string, ModelReference | undefined>>;

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Whether `fabric.yaml` points a connection at a real model. A deleted block
 * and the `<…>` placeholders the template ships with both count as not set up,
 * so a customer without that model never sees a page that can't load.
 */
export function isConnectionConfigured(models: ModelReferences, alias: string): boolean {
    const model = models[alias];
    return GUID.test(model?.workspaceId?.trim() ?? "") && GUID.test(model?.itemId?.trim() ?? "");
}
