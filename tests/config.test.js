import { defaultConfig, createDefaultConfig } from '../src/config.js';

describe('config.js', () => {

    test('defaultConfig should contain stall detection configurations', () => {
        expect(defaultConfig).toHaveProperty('stallTimeout');
        expect(defaultConfig.stallTimeout).toBe(5000);

        expect(defaultConfig).toHaveProperty('maxStallRetries');
        expect(defaultConfig.maxStallRetries).toBe(5);

        expect(defaultConfig).toHaveProperty('preloadRecoverDuration');
        expect(defaultConfig.preloadRecoverDuration).toBe(2.0);

        expect(defaultConfig).toHaveProperty('usePlaybackWaitEvent');
        expect(defaultConfig.usePlaybackWaitEvent).toBe(true);
    });

    test('createDefaultConfig should return a copy of defaultConfig', () => {
        const config1 = createDefaultConfig();
        const config2 = createDefaultConfig();

        expect(config1).not.toBe(defaultConfig);
        expect(config1).not.toBe(config2);
        expect(config1).toEqual(defaultConfig);
        expect(config2).toEqual(defaultConfig);
    });

    test('modifying created config should not affect defaultConfig', () => {
        const config = createDefaultConfig();
        config.stallTimeout = 10000;
        config.maxStallRetries = 10;

        expect(defaultConfig.stallTimeout).toBe(5000);
        expect(defaultConfig.maxStallRetries).toBe(5);
        expect(config.stallTimeout).toBe(10000);
        expect(config.maxStallRetries).toBe(10);
    });

    test('defaultConfig should contain expected legacy properties', () => {
        expect(defaultConfig).toHaveProperty('enableWorker', false);
        expect(defaultConfig).toHaveProperty('isLive', false);
        expect(defaultConfig).toHaveProperty('lazyLoad', true);
        expect(defaultConfig).toHaveProperty('accurateSeek', false);
    });

});
