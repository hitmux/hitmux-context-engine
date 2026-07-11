import assert from "node:assert/strict";
import test from "node:test";

import {
    CURRENT_DIRECTORY_NOT_INDEXED_NOTICE,
    getCurrentDirectoryIndexNotice,
    prependStartupIndexNotice,
} from "./startup-index-notice.js";

test("startup index notice identifies an unindexed current directory", () => {
    let checkedPath: string | undefined;

    const notice = getCurrentDirectoryIndexNotice(
        {
            findIndexedCodebasePath: (codebasePath) => {
                checkedPath = codebasePath;
                return undefined;
            },
        },
        "/workspace/project",
    );

    assert.equal(checkedPath, "/workspace/project");
    assert.equal(notice, CURRENT_DIRECTORY_NOT_INDEXED_NOTICE);
});

test("startup index notice is omitted when the current directory is inside an indexed root", () => {
    const notice = getCurrentDirectoryIndexNotice(
        {
            findIndexedCodebasePath: () => "/workspace",
        },
        "/workspace/project",
    );

    assert.equal(notice, undefined);
});

test("startup index notice is prepended without changing indexed descriptions", () => {
    const description = "\nSearch indexed context.";

    assert.equal(
        prependStartupIndexNotice(description, CURRENT_DIRECTORY_NOT_INDEXED_NOTICE),
        `${CURRENT_DIRECTORY_NOT_INDEXED_NOTICE}\n\nSearch indexed context.`,
    );
    assert.equal(prependStartupIndexNotice(description, undefined), description);
});
