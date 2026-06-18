const EventEmitter = require('events');

global.EventEmitter = EventEmitter;

global.performance = {
    now: jest.fn(() => Date.now())
};

global.setInterval = jest.fn((callback) => {
    return 1;
});
global.clearInterval = jest.fn();
global.setTimeout = jest.fn((callback) => {
    return 1;
});
global.clearTimeout = jest.fn();

global.window = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    performance: global.performance,
    URL: {
        createObjectURL: jest.fn(() => 'blob:mock-url')
    },
    navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
};
global.self = global.window;
global.navigator = global.window.navigator;

global.document = {
    createElement: jest.fn(() => ({
        addEventListener: jest.fn(),
        removeEventListener: jest.fn()
    }))
};

class MockMediaSource {
    constructor() {
        this.readyState = 'closed';
        this.sourceBuffers = [];
        this.duration = NaN;
    }
    static isTypeSupported() { return true; }
    addSourceBuffer() {
        const sb = {
            appendBuffer: jest.fn(),
            remove: jest.fn(),
            abort: jest.fn(),
            timestampOffset: 0,
            appendWindowStart: 0,
            appendWindowEnd: Infinity,
            updating: false,
            buffered: {
                length: 0,
                start: () => 0,
                end: () => 0
            }
        };
        this.sourceBuffers.push(sb);
        return sb;
    }
    endOfStream() {
        this.readyState = 'ended';
    }
}

global.MediaSource = MockMediaSource;
global.URL = global.window.URL;

class MockTimeRanges {
    constructor(ranges = []) {
        this._ranges = ranges;
    }
    get length() { return this._ranges.length; }
    start(i) { return this._ranges[i][0]; }
    end(i) { return this._ranges[i][1]; }
}

global.MockTimeRanges = MockTimeRanges;

global.Worker = class MockWorker {
    constructor() {
        this._listeners = {};
    }
    postMessage() {}
    addEventListener(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
    }
    removeEventListener() {}
    terminate() {}
};

global.Blob = class MockBlob {
    constructor() {}
};
