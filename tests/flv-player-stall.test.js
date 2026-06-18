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
                playbackRate: 1.0,
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
            _recoverSeekTime: 0,
            _preloadChecker: null,
            _preloadLastBufferEnd: 0,
            _preloadLastCheckTime: 0,
            _preloadLastCurrentTime: 0,
            _preloadConsumptionRate: 0,
            _preloadMinInterval: 50,
            _preloadMaxInterval: 500,
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
        context._recoverFromStall = FlvPlayer.prototype._recoverFromStall.bind(context);
        context._onvTimeUpdate = FlvPlayer.prototype._onvTimeUpdate.bind(context);
        context._onvWaiting = FlvPlayer.prototype._onvWaiting.bind(context);
        context._onvPlaying = FlvPlayer.prototype._onvPlaying.bind(context);
        context._schedulePreloadCheck = FlvPlayer.prototype._schedulePreloadCheck.bind(context);
        context._getCurrentBufferEnd = FlvPlayer.prototype._getCurrentBufferEnd.bind(context);

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

    describe('Stall recovery mechanism', () => {

        test('_tryRecoverFromStall should seek to bufferStatus endDts when available', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 0
            });
            const FlvPlayerInner = require('../src/player/flv-player.js').default;

            context._tryRecoverFromStall.mockRestore();
            context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);

            context._bufferStatus = { startDts: 5000, endDts: 15000 };
            context._mediaElement.currentTime = 9.9;
            setBuffered([[0, 10]]);

            context._tryRecoverFromStall();

            expect(context._mediaElement.pause).toHaveBeenCalled();
            expect(context._stallRetryCount).toBe(1);
            expect(context._recovering).toBe(false);
            expect(context._recoverSeekTime).toBeCloseTo(14.9, 1);
            expect(context._mediaElement.currentTime).toBeCloseTo(14.9, 1);
            expect(context._mediaElement.play).toHaveBeenCalled();
        });

        test('_tryRecoverFromStall should fallback to media buffered when bufferStatus not available', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 0
            });
            const FlvPlayerInner = require('../src/player/flv-player.js').default;

            context._tryRecoverFromStall.mockRestore();
            context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);

            context._bufferStatus = null;
            context._mediaElement.currentTime = 9.9;
            setBuffered([[0, 15]]);

            context._tryRecoverFromStall();

            expect(context._mediaElement.pause).toHaveBeenCalled();
            expect(context._stallRetryCount).toBe(1);
            expect(context._recoverSeekTime).toBeCloseTo(14.9, 1);
            expect(context._mediaElement.play).toHaveBeenCalled();
        });

        test('_tryRecoverFromStall should enable preload checker when preloadRecoverDuration > 0', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 2.0
            });
            const FlvPlayerInner = require('../src/player/flv-player.js').default;

            context._tryRecoverFromStall.mockRestore();
            context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);
            jest.spyOn(context, '_enablePreloadChecker');

            context._bufferStatus = { endDts: 15000 };
            setBuffered([[0, 15]]);

            context._tryRecoverFromStall();

            expect(context._mediaElement.pause).toHaveBeenCalled();
            expect(context._recovering).toBe(true);
            expect(context._enablePreloadChecker).toHaveBeenCalled();
            expect(context._mediaElement.play).not.toHaveBeenCalled();
        });

        test('_tryRecoverFromStall should do nothing when no recoverable buffer available', () => {
            const { context, setBuffered } = createMockContext();
            const FlvPlayerInner = require('../src/player/flv-player.js').default;

            context._tryRecoverFromStall.mockRestore();
            context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);

            context._bufferStatus = null;
            context._mediaElement.currentTime = 9.9;
            setBuffered([[0, 10]]);

            context._tryRecoverFromStall();

            expect(context._mediaElement.pause).not.toHaveBeenCalled();
            expect(context._stallRetryCount).toBe(0);
            expect(context._recovering).toBe(false);
        });

        test('_tryRecoverFromStall should reset waiting state after recovery', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 0
            });
            const FlvPlayerInner = require('../src/player/flv-player.js').default;

            context._tryRecoverFromStall.mockRestore();
            context._tryRecoverFromStall = FlvPlayerInner.prototype._tryRecoverFromStall.bind(context);

            context._waiting = true;
            context._waitingBeginTime = 95000;
            context._bufferStatus = { endDts: 15000 };
            setBuffered([[0, 15]]);

            context._tryRecoverFromStall();

            expect(context._waiting).toBe(false);
            expect(context._waitingBeginTime).toBe(0);
        });

        test('_recoverFromStall should emit RECOVERED event with correct data', () => {
            const { context } = createMockContext();

            context._stalled = true;
            context._stallBeginTime = context._now() - 5000;
            context._stallRetryCount = 3;
            context._mediaElement.currentTime = 15.5;

            context._recoverFromStall();

            expect(context._emitter.emit).toHaveBeenCalledWith(
                PlayerEvents.RECOVERED,
                expect.objectContaining({
                    currentTime: 15.5,
                    stalledDuration: expect.closeTo(5.0, 1),
                    retryCount: 3
                })
            );
            expect(context._stalled).toBe(false);
            expect(context._stallRetryCount).toBe(0);
        });

        test('_onvTimeUpdate should trigger recovery when stalled and buffer available', () => {
            const { context, setBuffered } = createMockContext();
            jest.spyOn(context, '_recoverFromStall');

            context._stalled = true;
            context._stallBeginTime = context._now() - 3000;
            context._mediaElement.paused = false;
            context._mediaElement.seeking = false;
            context._mediaElement.currentTime = 12.0;
            setBuffered([[0, 20]]);

            context._onvTimeUpdate();

            expect(context._recoverFromStall).toHaveBeenCalled();
            expect(context._lastCurrentTime).toBe(12.0);
            expect(context._lastTimeUpdateTime).toBe(context._now());
        });

        test('_onvTimeUpdate should not recover when still at buffer edge', () => {
            const { context, setBuffered } = createMockContext();
            jest.spyOn(context, '_recoverFromStall');

            context._stalled = true;
            context._mediaElement.paused = false;
            context._mediaElement.currentTime = 9.98;
            setBuffered([[0, 10]]);

            context._onvTimeUpdate();

            expect(context._recoverFromStall).not.toHaveBeenCalled();
        });

        test('_onvWaiting should set waiting state when not stalled/recovering', () => {
            const { context } = createMockContext();

            context._stalled = false;
            context._recovering = false;

            context._onvWaiting();

            expect(context._waiting).toBe(true);
            expect(context._waitingBeginTime).toBe(context._now());
        });

        test('_onvWaiting should not set waiting state when already stalled', () => {
            const { context } = createMockContext();

            context._stalled = true;
            context._recovering = false;

            context._onvWaiting();

            expect(context._waiting).toBe(false);
            expect(context._waitingBeginTime).toBe(0);
        });

        test('_onvPlaying should trigger recovery when stalled', () => {
            const { context } = createMockContext();
            jest.spyOn(context, '_recoverFromStall');

            context._stalled = true;
            context._recovering = false;

            context._onvPlaying();

            expect(context._recoverFromStall).toHaveBeenCalled();
            expect(context._waiting).toBe(false);
            expect(context._waitingBeginTime).toBe(0);
        });

        test('_onvPlaying should ignore when recovering', () => {
            const { context } = createMockContext();
            jest.spyOn(context, '_recoverFromStall');

            context._stalled = true;
            context._recovering = true;

            context._onvPlaying();

            expect(context._recoverFromStall).not.toHaveBeenCalled();
        });

        test('_onvTimeUpdate should clear waiting state when playing normally', () => {
            const { context } = createMockContext();

            context._waiting = true;
            context._waitingBeginTime = context._now() - 2000;
            context._mediaElement.paused = false;
            context._mediaElement.seeking = false;

            context._onvTimeUpdate();

            expect(context._waiting).toBe(false);
            expect(context._waitingBeginTime).toBe(0);
        });

    });

    describe('Preload dynamic interval adjustment', () => {

        test('preload checker should use min interval when net growth rate is negative', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 3.0
            });
            jest.spyOn(context, '_schedulePreloadCheck');

            context._recovering = true;
            context._recoverSeekTime = 10.0;
            setBuffered([[0, 11.0]]);
            context._preloadLastCheckTime = context._now() - 1000;
            context._preloadLastBufferEnd = 11.5;
            context._preloadLastCurrentTime = 10.0;
            context._preloadConsumptionRate = 2.0;

            context._checkPreloadReady();

            expect(context._schedulePreloadCheck).toHaveBeenCalledWith(
                context._preloadMinInterval
            );
        });

        test('preload checker should schedule based on net growth rate when positive', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 3.0
            });
            jest.spyOn(context, '_schedulePreloadCheck');

            context._recovering = true;
            context._recoverSeekTime = 10.0;
            setBuffered([[0, 11.0]]);
            context._preloadLastCheckTime = context._now() - 1000;
            context._preloadLastBufferEnd = 10.0;
            context._preloadLastCurrentTime = 10.0;
            context._preloadConsumptionRate = 1.0;

            context._checkPreloadReady();

            expect(context._schedulePreloadCheck).toHaveBeenCalled();
            const scheduledInterval = context._schedulePreloadCheck.mock.calls[0][0];
            expect(scheduledInterval).toBeGreaterThanOrEqual(context._preloadMinInterval);
            expect(scheduledInterval).toBeLessThanOrEqual(context._preloadMaxInterval);
        });

        test('preload checker should use progress ratio fallback when no growth data', () => {
            const { context, setBuffered } = createMockContext({
                preloadRecoverDuration: 2.0
            });
            jest.spyOn(context, '_schedulePreloadCheck');

            context._recovering = true;
            context._recoverSeekTime = 10.0;
            setBuffered([[0, 11.0]]);
            context._preloadLastCheckTime = context._now() - 1000;
            context._preloadLastBufferEnd = 11.0;
            context._preloadLastCurrentTime = 10.0;
            context._preloadConsumptionRate = 0;

            context._checkPreloadReady();

            expect(context._schedulePreloadCheck).toHaveBeenCalled();
            const scheduledInterval = context._schedulePreloadCheck.mock.calls[0][0];
            expect(scheduledInterval).toBeGreaterThanOrEqual(context._preloadMinInterval);
            expect(scheduledInterval).toBeLessThanOrEqual(context._preloadMaxInterval);
        });

        test('_enablePreloadChecker should initialize consumption tracking', () => {
            const { context } = createMockContext();
            context._mediaElement.paused = false;
            context._mediaElement.currentTime = 15.0;
            context._mediaElement.playbackRate = 1.5;

            context._enablePreloadChecker();

            expect(context._preloadLastCurrentTime).toBe(15.0);
            expect(context._preloadConsumptionRate).toBe(1.5);
            expect(context._preloadChecker).not.toBeNull();
        });

        test('preload checker should exit early when not recovering', () => {
            const { context, setBuffered } = createMockContext();
            jest.spyOn(context, '_schedulePreloadCheck');

            context._recovering = false;
            setBuffered([[0, 20]]);

            context._checkPreloadReady();

            expect(context._preloadChecker).toBeNull();
            expect(context._schedulePreloadCheck).not.toHaveBeenCalled();
            expect(context._mediaElement.play).not.toHaveBeenCalled();
        });

    });

});
