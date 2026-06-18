/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import EventEmitter from 'events';
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import PlayerEvents from './player-events.js';
import Transmuxer from '../core/transmuxer.js';
import TransmuxingEvents from '../core/transmuxing-events.js';
import MSEController from '../core/mse-controller.js';
import MSEEvents from '../core/mse-events.js';
import {ErrorTypes, ErrorDetails} from './player-errors.js';
import {createDefaultConfig} from '../config.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

class FlvPlayer {

    constructor(mediaDataSource, config) {
        this.TAG = 'FlvPlayer';
        this._type = 'FlvPlayer';
        this._emitter = new EventEmitter();

        this._config = createDefaultConfig();
        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        if (mediaDataSource.type.toLowerCase() !== 'flv') {
            throw new InvalidArgumentException('FlvPlayer requires an flv MediaDataSource input!');
        }

        if (mediaDataSource.isLive === true) {
            this._config.isLive = true;
        }

        this.e = {
            onvLoadedMetadata: this._onvLoadedMetadata.bind(this),
            onvSeeking: this._onvSeeking.bind(this),
            onvCanPlay: this._onvCanPlay.bind(this),
            onvStalled: this._onvStalled.bind(this),
            onvProgress: this._onvProgress.bind(this),
            onvTimeUpdate: this._onvTimeUpdate.bind(this),
            onvWaiting: this._onvWaiting.bind(this),
            onvPlaying: this._onvPlaying.bind(this)
        };

        if (self.performance && self.performance.now) {
            this._now = self.performance.now.bind(self.performance);
        } else {
            this._now = Date.now;
        }

        this._pendingSeekTime = null;  // in seconds
        this._requestSetTime = false;
        this._seekpointRecord = null;
        this._progressChecker = null;

        this._mediaDataSource = mediaDataSource;
        this._mediaElement = null;
        this._msectl = null;
        this._transmuxer = null;

        this._mseSourceOpened = false;
        this._hasPendingLoad = false;
        this._receivedCanPlay = false;

        this._mediaInfo = null;
        this._statisticsInfo = null;

        this._stalled = false;
        this._stallBeginTime = 0;
        this._stallRetryCount = 0;
        this._lastCurrentTime = 0;
        this._lastTimeUpdateTime = 0;
        this._stallChecker = null;
        this._bufferStatus = null;

        this._waiting = false;
        this._waitingBeginTime = 0;
        this._recovering = false;
        this._recoverSeekTime = 0;
        this._preloadChecker = null;
        this._preloadLastBufferEnd = 0;
        this._preloadLastCheckTime = 0;
        this._preloadLastCurrentTime = 0;
        this._preloadConsumptionRate = 0;
        this._preloadMinInterval = 50;
        this._preloadMaxInterval = 500;

        let chromeNeedIDRFix = (Browser.chrome &&
                               (Browser.version.major < 50 ||
                               (Browser.version.major === 50 && Browser.version.build < 2661)));
        this._alwaysSeekKeyframe = (chromeNeedIDRFix || Browser.msedge || Browser.msie) ? true : false;

        if (this._alwaysSeekKeyframe) {
            this._config.accurateSeek = false;
        }
    }

    destroy() {
        if (this._progressChecker != null) {
            window.clearInterval(this._progressChecker);
            this._progressChecker = null;
        }
        if (this._stallChecker != null) {
            window.clearInterval(this._stallChecker);
            this._stallChecker = null;
        }
        if (this._preloadChecker != null) {
            window.clearInterval(this._preloadChecker);
            this._preloadChecker = null;
        }
        if (this._transmuxer) {
            this.unload();
        }
        if (this._mediaElement) {
            this.detachMediaElement();
        }
        this.e = null;
        this._mediaDataSource = null;

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        if (event === PlayerEvents.MEDIA_INFO) {
            if (this._mediaInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo);
                });
            }
        } else if (event === PlayerEvents.STATISTICS_INFO) {
            if (this._statisticsInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo);
                });
            }
        }
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    attachMediaElement(mediaElement) {
        this._mediaElement = mediaElement;
        mediaElement.addEventListener('loadedmetadata', this.e.onvLoadedMetadata);
        mediaElement.addEventListener('seeking', this.e.onvSeeking);
        mediaElement.addEventListener('canplay', this.e.onvCanPlay);
        mediaElement.addEventListener('stalled', this.e.onvStalled);
        mediaElement.addEventListener('progress', this.e.onvProgress);
        mediaElement.addEventListener('timeupdate', this.e.onvTimeUpdate);
        mediaElement.addEventListener('waiting', this.e.onvWaiting);
        mediaElement.addEventListener('playing', this.e.onvPlaying);

        this._msectl = new MSEController(this._config);

        this._msectl.on(MSEEvents.UPDATE_END, this._onmseUpdateEnd.bind(this));
        this._msectl.on(MSEEvents.BUFFER_FULL, this._onmseBufferFull.bind(this));
        this._msectl.on(MSEEvents.SOURCE_OPEN, () => {
            this._mseSourceOpened = true;
            if (this._hasPendingLoad) {
                this._hasPendingLoad = false;
                this.load();
            }
        });
        this._msectl.on(MSEEvents.ERROR, (info) => {
            this._emitter.emit(PlayerEvents.ERROR,
                               ErrorTypes.MEDIA_ERROR,
                               ErrorDetails.MEDIA_MSE_ERROR,
                               info
            );
        });

        this._msectl.attachMediaElement(mediaElement);

        if (this._pendingSeekTime != null) {
            try {
                mediaElement.currentTime = this._pendingSeekTime;
                this._pendingSeekTime = null;
            } catch (e) {
                // IE11 may throw InvalidStateError if readyState === 0
                // We can defer set currentTime operation after loadedmetadata
            }
        }
    }

    detachMediaElement() {
        if (this._mediaElement) {
            this._msectl.detachMediaElement();
            this._mediaElement.removeEventListener('loadedmetadata', this.e.onvLoadedMetadata);
            this._mediaElement.removeEventListener('seeking', this.e.onvSeeking);
            this._mediaElement.removeEventListener('canplay', this.e.onvCanPlay);
            this._mediaElement.removeEventListener('stalled', this.e.onvStalled);
            this._mediaElement.removeEventListener('progress', this.e.onvProgress);
            this._mediaElement.removeEventListener('timeupdate', this.e.onvTimeUpdate);
            this._mediaElement.removeEventListener('waiting', this.e.onvWaiting);
            this._mediaElement.removeEventListener('playing', this.e.onvPlaying);
            this._mediaElement = null;
        }
        if (this._msectl) {
            this._msectl.destroy();
            this._msectl = null;
        }
    }

    load() {
        if (!this._mediaElement) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }
        if (this._transmuxer) {
            throw new IllegalStateException('FlvPlayer.load() has been called, please call unload() first!');
        }
        if (this._hasPendingLoad) {
            return;
        }

        if (this._config.deferLoadAfterSourceOpen && this._mseSourceOpened === false) {
            this._hasPendingLoad = true;
            return;
        }

        if (this._mediaElement.readyState > 0) {
            this._requestSetTime = true;
            // IE11 may throw InvalidStateError if readyState === 0
            this._mediaElement.currentTime = 0;
        }

        this._transmuxer = new Transmuxer(this._mediaDataSource, this._config);

        this._transmuxer.on(TransmuxingEvents.INIT_SEGMENT, (type, is) => {
            this._msectl.appendInitSegment(is);
        });
        this._transmuxer.on(TransmuxingEvents.MEDIA_SEGMENT, (type, ms) => {
            this._msectl.appendMediaSegment(ms);

            // lazyLoad check
            if (this._config.lazyLoad && !this._config.isLive) {
                let currentTime = this._mediaElement.currentTime;
                if (ms.info.endDts >= (currentTime + this._config.lazyLoadMaxDuration) * 1000) {
                    if (this._progressChecker == null) {
                        Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
                        this._suspendTransmuxer();
                    }
                }
            }
        });
        this._transmuxer.on(TransmuxingEvents.LOADING_COMPLETE, () => {
            this._msectl.endOfStream();
            this._emitter.emit(PlayerEvents.LOADING_COMPLETE);
        });
        this._transmuxer.on(TransmuxingEvents.RECOVERED_EARLY_EOF, () => {
            this._emitter.emit(PlayerEvents.RECOVERED_EARLY_EOF);
        });
        this._transmuxer.on(TransmuxingEvents.IO_ERROR, (detail, info) => {
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.NETWORK_ERROR, detail, info);
        });
        this._transmuxer.on(TransmuxingEvents.DEMUX_ERROR, (detail, info) => {
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.MEDIA_ERROR, detail, {code: -1, msg: info});
        });
        this._transmuxer.on(TransmuxingEvents.MEDIA_INFO, (mediaInfo) => {
            this._mediaInfo = mediaInfo;
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        });
        this._transmuxer.on(TransmuxingEvents.METADATA_ARRIVED, (metadata) => {
            this._emitter.emit(PlayerEvents.METADATA_ARRIVED, metadata);
        });
        this._transmuxer.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, (data) => {
            this._emitter.emit(PlayerEvents.SCRIPTDATA_ARRIVED, data);
        });
        this._transmuxer.on(TransmuxingEvents.STATISTICS_INFO, (statInfo) => {
            this._statisticsInfo = this._fillStatisticsInfo(statInfo);
            this._emitter.emit(PlayerEvents.STATISTICS_INFO, Object.assign({}, this._statisticsInfo));
        });
        this._transmuxer.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, (milliseconds) => {
            if (this._mediaElement && !this._config.accurateSeek) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = milliseconds / 1000;
            }
        });
        this._transmuxer.on(TransmuxingEvents.BUFFER_STATUS, (status) => {
            this._bufferStatus = status;
        });

        this._resetStallState();
        this._enableStallChecker();

        this._transmuxer.open();
    }

    unload() {
        if (this._mediaElement) {
            this._mediaElement.pause();
        }
        this._disableStallChecker();
        this._disablePreloadChecker();
        this._resetStallState();
        if (this._msectl) {
            this._msectl.seek(0);
        }
        if (this._transmuxer) {
            this._transmuxer.close();
            this._transmuxer.destroy();
            this._transmuxer = null;
        }
        this._bufferStatus = null;
    }

    play() {
        return this._mediaElement.play();
    }

    pause() {
        this._mediaElement.pause();
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._mediaElement.buffered;
    }

    get duration() {
        return this._mediaElement.duration;
    }

    get volume() {
        return this._mediaElement.volume;
    }

    set volume(value) {
        this._mediaElement.volume = value;
    }

    get muted() {
        return this._mediaElement.muted;
    }

    set muted(muted) {
        this._mediaElement.muted = muted;
    }

    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    set currentTime(seconds) {
        if (this._mediaElement) {
            this._internalSeek(seconds);
        } else {
            this._pendingSeekTime = seconds;
        }
    }

    get mediaInfo() {
        return Object.assign({}, this._mediaInfo);
    }

    get statisticsInfo() {
        if (this._statisticsInfo == null) {
            this._statisticsInfo = {};
        }
        this._statisticsInfo = this._fillStatisticsInfo(this._statisticsInfo);
        return Object.assign({}, this._statisticsInfo);
    }

    get bufferStatus() {
        if (this._transmuxer) {
            return this._transmuxer.bufferStatus;
        }
        return {
            startDts: null,
            endDts: null
        };
    }

    _fillStatisticsInfo(statInfo) {
        statInfo.playerType = this._type;

        if (!(this._mediaElement instanceof HTMLVideoElement)) {
            return statInfo;
        }

        let hasQualityInfo = true;
        let decoded = 0;
        let dropped = 0;

        if (this._mediaElement.getVideoPlaybackQuality) {
            let quality = this._mediaElement.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames;
            dropped = quality.droppedVideoFrames;
        } else if (this._mediaElement.webkitDecodedFrameCount != undefined) {
            decoded = this._mediaElement.webkitDecodedFrameCount;
            dropped = this._mediaElement.webkitDroppedFrameCount;
        } else {
            hasQualityInfo = false;
        }

        if (hasQualityInfo) {
            statInfo.decodedFrames = decoded;
            statInfo.droppedFrames = dropped;
        }

        return statInfo;
    }

    _onmseUpdateEnd() {
        if (!this._config.lazyLoad || this._config.isLive) {
            return;
        }

        let buffered = this._mediaElement.buffered;
        let currentTime = this._mediaElement.currentTime;
        let currentRangeStart = 0;
        let currentRangeEnd = 0;

        for (let i = 0; i < buffered.length; i++) {
            let start = buffered.start(i);
            let end = buffered.end(i);
            if (start <= currentTime && currentTime < end) {
                currentRangeStart = start;
                currentRangeEnd = end;
                break;
            }
        }

        if (currentRangeEnd >= currentTime + this._config.lazyLoadMaxDuration && this._progressChecker == null) {
            Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
            this._suspendTransmuxer();
        }
    }

    _onmseBufferFull() {
        Log.v(this.TAG, 'MSE SourceBuffer is full, suspend transmuxing task');
        if (this._progressChecker == null) {
            this._suspendTransmuxer();
        }
    }

    _suspendTransmuxer() {
        if (this._transmuxer) {
            this._transmuxer.pause();

            if (this._progressChecker == null) {
                this._progressChecker = window.setInterval(this._checkProgressAndResume.bind(this), 1000);
            }
        }
    }

    _checkProgressAndResume() {
        let currentTime = this._mediaElement.currentTime;
        let buffered = this._mediaElement.buffered;

        let needResume = false;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            let to = buffered.end(i);
            if (currentTime >= from && currentTime < to) {
                if (currentTime >= to - this._config.lazyLoadRecoverDuration) {
                    needResume = true;
                }
                break;
            }
        }

        if (needResume) {
            window.clearInterval(this._progressChecker);
            this._progressChecker = null;
            if (needResume) {
                Log.v(this.TAG, 'Continue loading from paused position');
                this._transmuxer.resume();
            }
        }
    }

    _isTimepointBuffered(seconds) {
        let buffered = this._mediaElement.buffered;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            let to = buffered.end(i);
            if (seconds >= from && seconds < to) {
                return true;
            }
        }
        return false;
    }

    _internalSeek(seconds) {
        let directSeek = this._isTimepointBuffered(seconds);

        let directSeekBegin = false;
        let directSeekBeginTime = 0;

        if (seconds < 1.0 && this._mediaElement.buffered.length > 0) {
            let videoBeginTime = this._mediaElement.buffered.start(0);
            if ((videoBeginTime < 1.0 && seconds < videoBeginTime) || Browser.safari) {
                directSeekBegin = true;
                // also workaround for Safari: Seek to 0 may cause video stuck, use 0.1 to avoid
                directSeekBeginTime = Browser.safari ? 0.1 : videoBeginTime;
            }
        }

        if (directSeekBegin) {  // seek to video begin, set currentTime directly if beginPTS buffered
            this._requestSetTime = true;
            this._mediaElement.currentTime = directSeekBeginTime;
        }  else if (directSeek) {  // buffered position
            if (!this._alwaysSeekKeyframe) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = seconds;
            } else {
                let idr = this._msectl.getNearestKeyframe(Math.floor(seconds * 1000));
                this._requestSetTime = true;
                if (idr != null) {
                    this._mediaElement.currentTime = idr.dts / 1000;
                } else {
                    this._mediaElement.currentTime = seconds;
                }
            }
            if (this._progressChecker != null) {
                this._checkProgressAndResume();
            }
        } else {
            if (this._progressChecker != null) {
                window.clearInterval(this._progressChecker);
                this._progressChecker = null;
            }
            this._msectl.seek(seconds);
            this._transmuxer.seek(Math.floor(seconds * 1000));  // in milliseconds
            // no need to set mediaElement.currentTime if non-accurateSeek,
            // just wait for the recommend_seekpoint callback
            if (this._config.accurateSeek) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = seconds;
            }
        }
    }

    _checkAndApplyUnbufferedSeekpoint() {
        if (this._seekpointRecord) {
            if (this._seekpointRecord.recordTime <= this._now() - 100) {
                let target = this._mediaElement.currentTime;
                this._seekpointRecord = null;
                if (!this._isTimepointBuffered(target)) {
                    if (this._progressChecker != null) {
                        window.clearTimeout(this._progressChecker);
                        this._progressChecker = null;
                    }
                    // .currentTime is consists with .buffered timestamp
                    // Chrome/Edge use DTS, while FireFox/Safari use PTS
                    this._msectl.seek(target);
                    this._transmuxer.seek(Math.floor(target * 1000));
                    // set currentTime if accurateSeek, or wait for recommend_seekpoint callback
                    if (this._config.accurateSeek) {
                        this._requestSetTime = true;
                        this._mediaElement.currentTime = target;
                    }
                }
            } else {
                window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
            }
        }
    }

    _checkAndResumeStuckPlayback(stalled) {
        let media = this._mediaElement;
        if (stalled || !this._receivedCanPlay || media.readyState < 2) {  // HAVE_CURRENT_DATA
            let buffered = media.buffered;
            if (buffered.length > 0 && media.currentTime < buffered.start(0)) {
                Log.w(this.TAG, `Playback seems stuck at ${media.currentTime}, seek to ${buffered.start(0)}`);
                this._requestSetTime = true;
                this._mediaElement.currentTime = buffered.start(0);
                this._mediaElement.removeEventListener('progress', this.e.onvProgress);
            }
        } else {
            // Playback didn't stuck, remove progress event listener
            this._mediaElement.removeEventListener('progress', this.e.onvProgress);
        }
    }

    _onvLoadedMetadata(e) {
        if (this._pendingSeekTime != null) {
            this._mediaElement.currentTime = this._pendingSeekTime;
            this._pendingSeekTime = null;
        }
    }

    _onvSeeking(e) {  // handle seeking request from browser's progress bar
        let target = this._mediaElement.currentTime;
        let buffered = this._mediaElement.buffered;

        if (this._requestSetTime) {
            this._requestSetTime = false;
            return;
        }

        if (target < 1.0 && buffered.length > 0) {
            // seek to video begin, set currentTime directly if beginPTS buffered
            let videoBeginTime = buffered.start(0);
            if ((videoBeginTime < 1.0 && target < videoBeginTime) || Browser.safari) {
                this._requestSetTime = true;
                // also workaround for Safari: Seek to 0 may cause video stuck, use 0.1 to avoid
                this._mediaElement.currentTime = Browser.safari ? 0.1 : videoBeginTime;
                return;
            }
        }

        if (this._isTimepointBuffered(target)) {
            if (this._alwaysSeekKeyframe) {
                let idr = this._msectl.getNearestKeyframe(Math.floor(target * 1000));
                if (idr != null) {
                    this._requestSetTime = true;
                    this._mediaElement.currentTime = idr.dts / 1000;
                }
            }
            if (this._progressChecker != null) {
                this._checkProgressAndResume();
            }
            return;
        }

        this._seekpointRecord = {
            seekPoint: target,
            recordTime: this._now()
        };
        window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
    }

    _onvCanPlay(e) {
        this._receivedCanPlay = true;
        this._mediaElement.removeEventListener('canplay', this.e.onvCanPlay);
    }

    _onvStalled(e) {
        this._checkAndResumeStuckPlayback(true);
    }

    _onvProgress(e) {
        this._checkAndResumeStuckPlayback();
    }

    _onvTimeUpdate(e) {
        let media = this._mediaElement;
        let now = this._now();
        let currentTime = media.currentTime;

        if (this._recovering && this._preloadLastCheckTime > 0 && this._preloadLastCurrentTime > 0) {
            let timeDelta = (now - this._preloadLastCheckTime) / 1000;
            if (timeDelta > 0) {
                let playDelta = currentTime - this._preloadLastCurrentTime;
                this._preloadConsumptionRate = Math.max(0, playDelta / timeDelta);
            }
        }

        this._lastCurrentTime = currentTime;
        this._lastTimeUpdateTime = now;

        if (this._stalled && !media.paused && !media.seeking) {
            let buffered = media.buffered;
            if (buffered.length > 0) {
                let currentTime = media.currentTime;
                for (let i = 0; i < buffered.length; i++) {
                    let start = buffered.start(i);
                    let end = buffered.end(i);
                    if (currentTime >= start && currentTime < end - 0.1) {
                        this._recoverFromStall();
                        break;
                    }
                }
            }
        }

        if (this._waiting && !media.paused && !media.seeking) {
            this._waiting = false;
            this._waitingBeginTime = 0;
        }
    }

    _onvWaiting(e) {
        if (!this._stalled && !this._recovering) {
            this._waiting = true;
            this._waitingBeginTime = this._now();
            Log.v(this.TAG, 'Playback waiting for data');
        }
    }

    _onvPlaying(e) {
        if (this._recovering) {
            return;
        }
        this._waiting = false;
        this._waitingBeginTime = 0;
        if (this._stalled) {
            this._recoverFromStall();
        }
    }

    _resetStallState() {
        this._stalled = false;
        this._stallBeginTime = 0;
        this._stallRetryCount = 0;
        this._lastCurrentTime = 0;
        this._lastTimeUpdateTime = 0;
        this._waiting = false;
        this._waitingBeginTime = 0;
        this._recovering = false;
        this._recoverSeekTime = 0;
    }

    _enableStallChecker() {
        if (this._stallChecker == null && this._config.stallTimeout > 0) {
            this._stallChecker = window.setInterval(this._checkPlaybackStall.bind(this), 500);
        }
    }

    _disableStallChecker() {
        if (this._stallChecker != null) {
            window.clearInterval(this._stallChecker);
            this._stallChecker = null;
        }
    }

    _enablePreloadChecker() {
        if (this._preloadChecker == null) {
            this._preloadLastBufferEnd = 0;
            this._preloadLastCheckTime = 0;
            this._preloadLastCurrentTime = this._mediaElement ? this._mediaElement.currentTime : 0;
            this._preloadConsumptionRate = this._mediaElement && !this._mediaElement.paused ? this._mediaElement.playbackRate : 0;
            this._schedulePreloadCheck(this._preloadMinInterval);
        }
    }

    _disablePreloadChecker() {
        if (this._preloadChecker != null) {
            window.clearTimeout(this._preloadChecker);
            this._preloadChecker = null;
        }
    }

    _schedulePreloadCheck(interval) {
        this._preloadChecker = window.setTimeout(this._checkPreloadReady.bind(this), interval);
    }

    _getCurrentBufferEnd() {
        let media = this._mediaElement;
        let buffered = media.buffered;
        let seekTime = this._recoverSeekTime;
        let maxBufferEnd = 0;

        if (buffered.length > 0) {
            for (let i = 0; i < buffered.length; i++) {
                let start = buffered.start(i);
                let end = buffered.end(i);
                if (start <= seekTime && end > seekTime) {
                    maxBufferEnd = end;
                    for (let j = i + 1; j < buffered.length; j++) {
                        let nextStart = buffered.start(j);
                        let nextEnd = buffered.end(j);
                        if (nextStart <= maxBufferEnd + 0.5) {
                            maxBufferEnd = nextEnd;
                        } else {
                            break;
                        }
                    }
                    break;
                }
            }
        }

        return maxBufferEnd;
    }

    _checkPreloadReady() {
        let media = this._mediaElement;
        if (!this._recovering || !media || media.seeking) {
            this._preloadChecker = null;
            return;
        }

        let now = this._now();
        let seekTime = this._recoverSeekTime;
        let preloadDuration = this._config.preloadRecoverDuration;
        let targetBufferEnd = seekTime + preloadDuration;
        let currentBufferEnd = this._getCurrentBufferEnd();

        if (currentBufferEnd >= targetBufferEnd) {
            Log.w(this.TAG, `Preload complete, ${preloadDuration}s buffered, resuming playback at ${seekTime.toFixed(3)}s`);
            this._disablePreloadChecker();
            this._recovering = false;
            this._requestSetTime = true;
            media.currentTime = seekTime;
            media.play().catch(() => {});
            return;
        }

        let nextInterval = this._preloadMaxInterval;

        if (this._preloadLastCheckTime > 0 && this._preloadLastBufferEnd > 0) {
            let timeDelta = (now - this._preloadLastCheckTime) / 1000;
            let bufferDelta = currentBufferEnd - this._preloadLastBufferEnd;
            let remainingBuffer = targetBufferEnd - currentBufferEnd;

            if (timeDelta > 0) {
                let bufferGrowthRate = bufferDelta > 0 ? bufferDelta / timeDelta : 0;
                let consumptionRate = this._preloadConsumptionRate > 0 ? this._preloadConsumptionRate : (media.paused ? 0 : media.playbackRate);
                let netGrowthRate = bufferGrowthRate - consumptionRate;

                if (netGrowthRate > 0 && remainingBuffer > 0) {
                    let estimatedTimeSeconds = remainingBuffer / netGrowthRate;
                    let estimatedTimeMs = estimatedTimeSeconds * 1000;
                    nextInterval = Math.max(
                        this._preloadMinInterval,
                        Math.min(this._preloadMaxInterval, estimatedTimeMs / 2)
                    );
                } else if (netGrowthRate <= 0) {
                    nextInterval = this._preloadMinInterval;
                } else {
                    let progressRatio = Math.max(0, Math.min(1, (currentBufferEnd - seekTime) / preloadDuration));
                    nextInterval = Math.max(
                        this._preloadMinInterval,
                        this._preloadMaxInterval * (1 - progressRatio * 0.7)
                    );
                }
            }
        }

        this._preloadLastBufferEnd = currentBufferEnd;
        this._preloadLastCheckTime = now;
        this._preloadLastCurrentTime = media.currentTime;

        this._schedulePreloadCheck(nextInterval);
    }

    _checkPlaybackStall() {
        let media = this._mediaElement;
        if (!media || media.paused || media.ended || media.seeking || this._recovering) {
            return;
        }

        let now = this._now();
        let currentTime = media.currentTime;
        let buffered = media.buffered;
        let playbackStalled = false;

        let timeSinceLastUpdate = now - this._lastTimeUpdateTime;
        if (this._lastTimeUpdateTime > 0 &&
            timeSinceLastUpdate >= this._config.stallTimeout &&
            Math.abs(currentTime - this._lastCurrentTime) < 0.01) {
            playbackStalled = true;
        }

        let waitingStalled = false;
        if (this._config.usePlaybackWaitEvent && this._waiting && this._waitingBeginTime > 0) {
            let waitingDuration = now - this._waitingBeginTime;
            if (waitingDuration >= this._config.stallTimeout) {
                waitingStalled = true;
            }
        }

        if (!playbackStalled && !waitingStalled) {
            return;
        }

        let reachedBufferEnd = false;
        if (buffered.length > 0) {
            for (let i = 0; i < buffered.length; i++) {
                let start = buffered.start(i);
                let end = buffered.end(i);
                if (currentTime >= start && currentTime < end) {
                    if (end - currentTime < 0.1) {
                        reachedBufferEnd = true;
                    }
                    break;
                }
                if (i === buffered.length - 1 && currentTime >= end) {
                    reachedBufferEnd = true;
                }
            }
        } else {
            reachedBufferEnd = true;
        }

        if ((playbackStalled || waitingStalled) && reachedBufferEnd) {
            if (!this._stalled) {
                this._stalled = true;
                this._stallBeginTime = now;
                let stallType = playbackStalled ? 'timeout' : 'waiting';
                Log.w(this.TAG, `Playback stalled at ${currentTime.toFixed(3)}s (detected by ${stallType})`);
                this._emitter.emit(PlayerEvents.STALLED, {
                    currentTime: currentTime,
                    bufferEnd: this._bufferStatus ? this._bufferStatus.endDts / 1000 : null,
                    type: stallType
                });
            }
            this._tryRecoverFromStall();
        }
    }

    _tryRecoverFromStall() {
        if (this._recovering) {
            return;
        }
        if (this._stallRetryCount >= this._config.maxStallRetries) {
            Log.w(this.TAG, `Max stall retries (${this._config.maxStallRetries}) reached, giving up`);
            return;
        }

        let media = this._mediaElement;
        let currentTime = media.currentTime;
        let buffered = media.buffered;

        let targetSeekTime = null;
        if (this._bufferStatus && this._bufferStatus.endDts != null) {
            let bufferEndTime = this._bufferStatus.endDts / 1000;
            if (bufferEndTime > currentTime + 0.1) {
                targetSeekTime = bufferEndTime - 0.1;
            }
        }

        if (targetSeekTime == null && buffered.length > 0) {
            for (let i = 0; i < buffered.length; i++) {
                let end = buffered.end(i);
                if (end > currentTime + 0.1) {
                    targetSeekTime = end - 0.1;
                    break;
                }
            }
        }

        if (targetSeekTime != null) {
            this._stallRetryCount++;
            this._recovering = true;
            this._recoverSeekTime = targetSeekTime;
            Log.w(this.TAG, `Stall recovery attempt #${this._stallRetryCount}: seek to ${targetSeekTime.toFixed(3)}s and preload ${this._config.preloadRecoverDuration}s`);

            media.pause();
            this._requestSetTime = true;
            media.currentTime = targetSeekTime;

            this._waiting = false;
            this._waitingBeginTime = 0;

            if (this._config.preloadRecoverDuration > 0) {
                this._enablePreloadChecker();
            } else {
                this._recovering = false;
                media.play().catch(() => {});
            }
        }
    }

    _recoverFromStall() {
        let media = this._mediaElement;
        let currentTime = media.currentTime;
        let stalledDuration = (this._now() - this._stallBeginTime) / 1000;
        Log.w(this.TAG, `Playback recovered at ${currentTime.toFixed(3)}s, stalled for ${stalledDuration.toFixed(3)}s after ${this._stallRetryCount} retries`);
        this._emitter.emit(PlayerEvents.RECOVERED, {
            currentTime: currentTime,
            stalledDuration: stalledDuration,
            retryCount: this._stallRetryCount
        });
        this._stalled = false;
        this._stallRetryCount = 0;
    }

}

export default FlvPlayer;