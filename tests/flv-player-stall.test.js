import PlayerEvents from '../src/player/player-events.js';
import { defaultConfig } from '../src/config.js';

describe('FlvPlayer stall detection logic', () => {

    const createMockContext = (configOverrides = {}) => {
        let currentTime = 10.0;
        const bufferedRanges = [[0, 20]];
        const FlvPlayer = require('../src/player/flv-player.js').default;

        const nowFn = jest.fn(() => 100000);

        const context = {
            _now: nowFn,
            _config: {
                ...defaultConfig,
                ...configOverrides
            },
            _mediaElement: {
                paused: false,
                ended: false,
                seeking: false,
                get currentTime() { return currentTime; },
                set currentTime(val) { currentTime = val; },
                buffered: {
                    get length() { return bufferedRanges.length; },
                    start: (i) => bufferedRanges[i][0],
                    end: (i) => bufferedRanges[i][1]
                },
                pause: jest.fn(),
                play: jest.fn(() => Promise.resolve())
            },
            _stalled: false,
            _stallBeginTime: 0,
            _stallRetryCount: 0,
            _waiting: false,
            _waitingBeginTime: 0,
            _recovering: false,
            _lastCurrentTime: 0,
            _lastTimeUpdateTime: 0,
            _bufferStatus: null,
            _emitter: {
                emit: jest.fn()
            },
            _requestSetTime: false,
            TAG: 'FlvPlayer'
        };

        context._checkPlaybackStall = FlvPlayer.prototype._checkPlaybackStall.bind(context);
        context._tryRecoverFromStall = FlvPlayer.prototype._tryRecoverFromStall.bind(context);
        context._resetStallState = FlvPlayer.prototype._resetStallState.bind(context);
        context._checkPreloadReady = FlvPlayer.prototype._checkPreloadReady.bind(context);
        context._enablePreloadChecker = FlvPlayer.prototype._enablePreloadChecker.bind(context);
        context._disablePreloadChecker = FlvPlayer.prototype._disablePreloadChecker.bind(context);

        jest.spyOn(context, '_tryRecoverFromStall');
        jest.spyOn(context, '_disablePreloadChecker');

        const setBuffered = (ranges) => {
            bufferedRanges.length = 0;
            ranges.forEach(r => bufferedRanges.push(r));
        };

        return { context, setBuffered };
    };

    test('should not detect stall when playback is progressing normally', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([[0, 20]]);
        context._mediaElement.currentTime = 10.0;
        context._lastCurrentTime = 9.5;
        context._lastTimeUpdateTime = context._now() - 1000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
        expect(context._emitter.emit).not.toHaveBeenCalled();
        expect(context._tryRecoverFromStall).not.toHaveBeenCalled();
    });

    test('should detect stall by timeout when timeupdate stalls and buffer is exhausted', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.95;
        context._lastTimeUpdateTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(true);
        expect(context._emitter.emit).toHaveBeenCalledWith(
            PlayerEvents.STALLED,
            expect.objectContaining({
                currentTime: 9.95,
                type: 'timeout'
            })
        );
        expect(context._tryRecoverFromStall).toHaveBeenCalled();
    });

    test('should detect stall by waiting event when waiting exceeds timeout', () => {
        const { context, setBuffered } = createMockContext({
            usePlaybackWaitEvent: true
        });

        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.95;
        context._lastTimeUpdateTime = context._now() - 1000;
        context._waiting = true;
        context._waitingBeginTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(true);
        expect(context._emitter.emit).toHaveBeenCalledWith(
            PlayerEvents.STALLED,
            expect.objectContaining({
                currentTime: 9.95,
                type: 'waiting'
            })
        );
        expect(context._tryRecoverFromStall).toHaveBeenCalled();
    });

    test('should not detect stall when buffer has data beyond current time', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([[0, 20]]);
        context._mediaElement.currentTime = 10.0;
        context._lastCurrentTime = 10.0;
        context._lastTimeUpdateTime = context._now() - 6000;
        context._waiting = true;
        context._waitingBeginTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
    });

    test('should not detect stall when paused', () => {
        const { context, setBuffered } = createMockContext();

        context._mediaElement.paused = true;
        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.95;
        context._lastTimeUpdateTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
    });

    test('should not detect stall when already recovering', () => {
        const { context, setBuffered } = createMockContext();

        context._recovering = true;
        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.95;
        context._lastTimeUpdateTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
    });

    test('should not detect stall by waiting when usePlaybackWaitEvent is false', () => {
        const { context, setBuffered } = createMockContext({
            usePlaybackWaitEvent: false
        });

        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.9;
        context._lastTimeUpdateTime = context._now() - 1000;
        context._waiting = true;
        context._waitingBeginTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
    });

    test('should not re-emit STALLED event on subsequent checks when already stalled', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([[0, 10]]);
        context._mediaElement.currentTime = 9.95;
        context._lastCurrentTime = 9.95;
        context._lastTimeUpdateTime = context._now() - 6000;

        context._checkPlaybackStall();
        context._checkPlaybackStall();

        expect(context._emitter.emit).toHaveBeenCalledTimes(1);
    });

    test('_resetStallState should reset all stall state variables', () => {
        const { context } = createMockContext();

        context._stalled = true;
        context._stallBeginTime = 100000;
        context._stallRetryCount = 3;
        context._lastCurrentTime = 10.5;
        context._lastTimeUpdateTime = 99000;
        context._waiting = true;
        context._waitingBeginTime = 95000;
        context._recovering = true;
        context._recoverSeekTime = 11.0;

        context._resetStallState();

        expect(context._stalled).toBe(false);
        expect(context._stallBeginTime).toBe(0);
        expect(context._stallRetryCount).toBe(0);
        expect(context._lastCurrentTime).toBe(0);
        expect(context._lastTimeUpdateTime).toBe(0);
        expect(context._waiting).toBe(false);
        expect(context._waitingBeginTime).toBe(0);
        expect(context._recovering).toBe(false);
        expect(context._recoverSeekTime).toBe(0);
    });

    test('should detect stall when no buffer and no timeupdate for timeout period', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([]);
        context._mediaElement.currentTime = 0;
        context._lastCurrentTime = 0;
        context._lastTimeUpdateTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(true);
    });

    test('should not detect stall when current time is within buffered range', () => {
        const { context, setBuffered } = createMockContext();

        setBuffered([[0, 15], [20, 30]]);
        context._mediaElement.currentTime = 12.0;
        context._lastCurrentTime = 12.0;
        context._lastTimeUpdateTime = context._now() - 6000;
        context._waiting = true;
        context._waitingBeginTime = context._now() - 6000;

        context._checkPlaybackStall();

        expect(context._stalled).toBe(false);
    });

    test('preload checker should not resume until enough buffer is available', () => {
        const { context, setBuffered } = createMockContext({
            preloadRecoverDuration: 2.0
        });

        context._recovering = true;
        context._recoverSeekTime = 10.0;
        setBuffered([[0, 10.5]]);

        context._checkPreloadReady();

        expect(context._mediaElement.play).not.toHaveBeenCalled();
        expect(context._recovering).toBe(true);

        setBuffered([[0, 12.0]]);

        context._checkPreloadReady();

        expect(context._mediaElement.play).toHaveBeenCalled();
        expect(context._recovering).toBe(false);
        expect(context._disablePreloadChecker).toHaveBeenCalled();
    });

    test('preload checker should not resume during seeking', () => {
        const { context, setBuffered } = createMockContext({
            preloadRecoverDuration: 2.0
        });

        context._recovering = true;
        context._recoverSeekTime = 10.0;
        context._mediaElement.seeking = true;
        setBuffered([[0, 15.0]]);

        context._checkPreloadReady();

        expect(context._mediaElement.play).not.toHaveBeenCalled();
    });

    test('preload checker should handle multiple buffered ranges', () => {
        const { context, setBuffered } = createMockContext({
            preloadRecoverDuration: 2.0
        });

        context._recovering = true;
        context._recoverSeekTime = 10.0;
        setBuffered([[0, 5], [8, 10.5], [11, 12.0]]);

        context._checkPreloadReady();

        expect(context._mediaElement.play).toHaveBeenCalled();
        expect(context._recovering).toBe(false);
    });

    test('preload checker should resume immediately when preloadRecoverDuration is 0', () => {
        const { context, setBuffered } = createMockContext({
            preloadRecoverDuration: 0
        });
        const FlvPlayerInner = require('../src/player/flv-player.js').default;

        context._tryRecoverFromStall.mockRestore();
        context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);
        context._bufferStatus = { endDts: 15000 };
        setBuffered([[0, 15]]);

        context._tryRecoverFromStall();

        expect(context._mediaElement.play).toHaveBeenCalled();
        expect(context._recovering).toBe(false);
    });

    test('_tryRecoverFromStall should not trigger when already recovering', () => {
        const { context, setBuffered } = createMockContext();

        context._recovering = true;
        setBuffered([[0, 15]]);

        context._tryRecoverFromStall();

        expect(context._mediaElement.pause).not.toHaveBeenCalled();
    });

    test('_tryRecoverFromStall should not trigger when max retries reached', () => {
        const { context, setBuffered } = createMockContext({
            maxStallRetries: 3
        });

        context._stallRetryCount = 3;
        setBuffered([[0, 15]]);

        context._tryRecoverFromStall();

        expect(context._mediaElement.pause).not.toHaveBeenCalled();
    });

});
