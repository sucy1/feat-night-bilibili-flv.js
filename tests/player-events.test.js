import PlayerEvents from '../src/player/player-events.js';
import TransmuxingEvents from '../src/core/transmuxing-events.js';

describe('player-events.js', () => {

    test('should contain STALLED and RECOVERED events', () => {
        expect(PlayerEvents).toHaveProperty('STALLED');
        expect(PlayerEvents.STALLED).toBe('stalled');

        expect(PlayerEvents).toHaveProperty('RECOVERED');
        expect(PlayerEvents.RECOVERED).toBe('recovered');
    });

    test('should contain existing events', () => {
        expect(PlayerEvents).toHaveProperty('ERROR', 'error');
        expect(PlayerEvents).toHaveProperty('LOADING_COMPLETE', 'loading_complete');
        expect(PlayerEvents).toHaveProperty('MEDIA_INFO', 'media_info');
        expect(PlayerEvents).toHaveProperty('STATISTICS_INFO', 'statistics_info');
    });

    test('all event values should be strings', () => {
        Object.values(PlayerEvents).forEach((value) => {
            expect(typeof value).toBe('string');
        });
    });

    test('event values should be unique', () => {
        const values = Object.values(PlayerEvents);
        const uniqueValues = [...new Set(values)];
        expect(values.length).toBe(uniqueValues.length);
    });

});

describe('transmuxing-events.js', () => {

    test('should contain BUFFER_STATUS event', () => {
        expect(TransmuxingEvents).toHaveProperty('BUFFER_STATUS');
        expect(TransmuxingEvents.BUFFER_STATUS).toBe('buffer_status');
    });

    test('should contain existing events', () => {
        expect(TransmuxingEvents).toHaveProperty('INIT_SEGMENT', 'init_segment');
        expect(TransmuxingEvents).toHaveProperty('MEDIA_SEGMENT', 'media_segment');
        expect(TransmuxingEvents).toHaveProperty('STATISTICS_INFO', 'statistics_info');
        expect(TransmuxingEvents).toHaveProperty('RECOMMEND_SEEKPOINT', 'recommend_seekpoint');
    });

    test('all event values should be strings', () => {
        Object.values(TransmuxingEvents).forEach((value) => {
            expect(typeof value).toBe('string');
        });
    });

});
