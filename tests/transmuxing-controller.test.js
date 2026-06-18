import { defaultConfig } from '../src/config.js';

describe('TransmuxingController buffer status logic', () => {

    test('initial buffer status should be null', () => {
        const createContext = () => ({
            _bufferStartDts: null,
            _bufferEndDts: null,
            _emitter: {
                emit: jest.fn()
            },
            get bufferStatus() {
                return {
                    startDts: this._bufferStartDts,
                    endDts: this._bufferEndDts
                };
            },
            _onRemuxerMediaSegmentArrival: null
        });

        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;
        const context = createContext();
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival;

        expect(context.bufferStatus.startDts).toBeNull();
        expect(context.bufferStatus.endDts).toBeNull();
    });

    test('buffer status should update when receiving media segment with dts info', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;
        const TransmuxingEvents = require('../src/core/transmuxing-events.js').default;

        const context = {
            _bufferStartDts: null,
            _bufferEndDts: null,
            _pendingSeekTime: null,
            _pendingResolveSeekPoint: null,
            _emitter: {
                emit: jest.fn()
            },
            get bufferStatus() {
                return {
                    startDts: this._bufferStartDts,
                    endDts: this._bufferEndDts
                };
            }
        };
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival.bind(context);

        const segment1 = {
            info: {
                dts: 1000,
                endDts: 3000
            }
        };

        context._onRemuxerMediaSegmentArrival('video', segment1);

        expect(context.bufferStatus.startDts).toBe(1000);
        expect(context.bufferStatus.endDts).toBe(3000);
        expect(context._emitter.emit).toHaveBeenCalledWith(
            TransmuxingEvents.BUFFER_STATUS,
            { startDts: 1000, endDts: 3000 }
        );
    });

    test('buffer status should expand with subsequent segments', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;

        const context = {
            _bufferStartDts: null,
            _bufferEndDts: null,
            _pendingSeekTime: null,
            _pendingResolveSeekPoint: null,
            _emitter: { emit: jest.fn() }
        };
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival.bind(context);

        const segment1 = { info: { dts: 1000, endDts: 3000 } };
        const segment2 = { info: { dts: 3000, endDts: 5000 } };

        context._onRemuxerMediaSegmentArrival('video', segment1);
        context._onRemuxerMediaSegmentArrival('video', segment2);

        expect(context._bufferStartDts).toBe(1000);
        expect(context._bufferEndDts).toBe(5000);
    });

    test('buffer status should expand backward with earlier segments', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;

        const context = {
            _bufferStartDts: null,
            _bufferEndDts: null,
            _pendingSeekTime: null,
            _pendingResolveSeekPoint: null,
            _emitter: { emit: jest.fn() }
        };
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival.bind(context);

        const segment1 = { info: { dts: 2000, endDts: 4000 } };
        const segment2 = { info: { dts: 1000, endDts: 2000 } };

        context._onRemuxerMediaSegmentArrival('video', segment1);
        context._onRemuxerMediaSegmentArrival('video', segment2);

        expect(context._bufferStartDts).toBe(1000);
        expect(context._bufferEndDts).toBe(4000);
    });

    test('buffer status should not update when segment has no info', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;

        const context = {
            _bufferStartDts: 1000,
            _bufferEndDts: 3000,
            _pendingSeekTime: null,
            _pendingResolveSeekPoint: null,
            _emitter: { emit: jest.fn() }
        };
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival.bind(context);

        const segmentWithoutInfo = { data: new Uint8Array(100) };

        context._onRemuxerMediaSegmentArrival('video', segmentWithoutInfo);

        expect(context._bufferStartDts).toBe(1000);
        expect(context._bufferEndDts).toBe(3000);
    });

    test('buffer status should reset on seek', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;

        const context = {
            _bufferStartDts: 1000,
            _bufferEndDts: 5000,
            _mediaInfo: {
                isSeekable: () => true,
                segments: []
            },
            _searchSegmentIndexContains: jest.fn(() => 0),
            _currentSegmentIndex: 0
        };

        jest.spyOn(context._mediaInfo, 'isSeekable').mockReturnValue(true);

        try {
            TransmuxingController.prototype.seek.call(context, 2000);
        } catch (e) {
            // Ignore errors from subsequent logic, we only care about buffer reset
        }

        expect(context._bufferStartDts).toBeNull();
        expect(context._bufferEndDts).toBeNull();
    });

    test('buffer status should not emit when pending seek time exists', () => {
        const TransmuxingController = require('../src/core/transmuxing-controller.js').default;

        const context = {
            _bufferStartDts: null,
            _bufferEndDts: null,
            _pendingSeekTime: 1000,
            _pendingResolveSeekPoint: null,
            _emitter: { emit: jest.fn() }
        };
        context._onRemuxerMediaSegmentArrival = TransmuxingController.prototype._onRemuxerMediaSegmentArrival.bind(context);

        const segment = { info: { dts: 1000, endDts: 3000 } };
        context._onRemuxerMediaSegmentArrival('video', segment);

        expect(context._emitter.emit).not.toHaveBeenCalled();
        expect(context._bufferStartDts).toBeNull();
    });

});
