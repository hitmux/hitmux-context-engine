if (process.env.HITMUX_TEST_VERBOSE !== "1") {
    const noop = () => undefined;

    console.debug = noop;
    console.info = noop;
    console.log = noop;
    console.warn = noop;
    console.error = noop;
}
