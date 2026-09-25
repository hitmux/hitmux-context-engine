#!/usr/bin/env node

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
    const options = args[0];
    const warningCode = warning instanceof Error
        ? warning.code
        : typeof options === "object" && options !== null
            ? options.code
            : args[1];
    if (warningCode !== "DEP0040") {
        originalEmitWarning(warning, ...args);
    }
};

const { runHitmuxContextEngineCli } = await import("../dist/index.js");

runHitmuxContextEngineCli();
