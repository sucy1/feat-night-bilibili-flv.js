import flvjs from '../';

type LoaderStatusAlias = flvjs.LoaderStatus;
type LoaderErrorsAlias = flvjs.LoaderErrors;

interface MediaDataSourceExt extends flvjs.MediaDataSource {
    example: string;
}

const player = flvjs.createPlayer({
    type: 'flv',
    url: 'http://example.com/test.flv'
}, {
    stallTimeout: 5000,
    maxStallRetries: 5,
    enableWorker: false
});

player.on(flvjs.Events.STALLED, (data: flvjs.StalledEventData) => {
    console.log('Stalled at:', data.currentTime, 'bufferEnd:', data.bufferEnd);
});

player.on(flvjs.Events.RECOVERED, (data: flvjs.RecoveredEventData) => {
    console.log('Recovered at:', data.currentTime, 'duration:', data.stalledDuration, 'retries:', data.retryCount);
});

const status: flvjs.BufferStatus = player.bufferStatus;
console.log('Buffer start:', status.startDts, 'end:', status.endDts);
