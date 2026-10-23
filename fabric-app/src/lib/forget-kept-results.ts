//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** Where a preview build kept query results on the device. The app no longer keeps any. */
export const KEPT_RESULTS_DATABASE = "analytics-hub-results";

function deviceStorage(): IDBFactory | undefined {
    try {
        return typeof indexedDB === "undefined" ? undefined : indexedDB;
    } catch {
        return undefined;
    }
}

/**
 * Deletes query results a preview build kept on this device, so none outlive
 * the model's next refresh. Sign-in and theme settings live elsewhere and are
 * untouched. Never throws: a page that may not use IndexedDB has nothing kept.
 */
export function forgetKeptResults(factory: IDBFactory | undefined = deviceStorage()): void {
    try {
        const request = factory?.deleteDatabase(KEPT_RESULTS_DATABASE);
        if (request) request.onerror = () => undefined;
    } catch {
        // Nothing to delete.
    }
}
