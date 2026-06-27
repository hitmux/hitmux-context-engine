import assert from "node:assert/strict";
import test from "node:test";

import { isHceDebugEnabled } from "./logger.js";

test("isHceDebugEnabled is disabled by default and for explicit false values", () => {
    for (const value of [undefined, "", "   ", "0", "false", "no", "off"]) {
        assert.equal(isHceDebugEnabled({ HCE_DEBUG: value }), false);
    }
});

test("isHceDebugEnabled is enabled for explicit true or custom non-empty values", () => {
    for (const value of ["1", "true", "yes", "debug", "anything"]) {
        assert.equal(isHceDebugEnabled({ HCE_DEBUG: value }), true);
    }
});
