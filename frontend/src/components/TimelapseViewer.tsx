import { useState, useRef, useEffect } from 'react';
import { X, Download, Film, Play, Pause, SkipBack, SkipForward, Pencil } from 'lucide-react';
import { Button } from './Button';
import { TimelapseEditorModal } from './TimelapseEditorModal';
import { formatMediaTime } from '../utils/date';
import { subscribeMediaToken, withMediaToken } from '../api/client';

interface TimelapseViewerProps {
  src: string;
  title: string;
  downloadFilename: string;
  archiveId?: number;
  onClose: () => void;
  onEdit?: () => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function TimelapseViewer({
  src,
  title,
  downloadFilename,
  archiveId,
  onClose,
  onEdit,
}: TimelapseViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [initialSource] = useState(() => withMediaToken(src));
  const failedPlayback = useRef<{ position: number; playing: boolean } | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1); // Default to 1x
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showEditor, setShowEditor] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.defaultPlaybackRate = playbackRate;
      video.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handleDurationChange = () => setDuration(video.duration);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
    };
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = parseFloat(e.target.value);
  };

  const skipBackward = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, video.currentTime - 5);
  };

  const skipForward = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(duration, video.currentTime + 5);
  };

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = withMediaToken(src);
    link.download = downloadFilename;
    link.click();
  };

  const retryWithCurrentCredential = () => {
    const video = videoRef.current;
    const playback = failedPlayback.current;
    const failedUrl = video?.getAttribute('src');
    if (!video || !playback || !failedUrl) return;
    const retryUrl = withMediaToken(failedUrl);
    if (retryUrl !== failedUrl) {
      video.autoplay = playback.playing;
      video.setAttribute('src', retryUrl);
    }
  };

  useEffect(() => subscribeMediaToken(retryWithCurrentCredential), []);

  const handleVideoError = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    failedPlayback.current ??= { position: event.currentTarget.currentTime, playing: isPlaying };
    retryWithCurrentCredential();
  };

  const restorePlayback = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const playback = failedPlayback.current;
    if (!playback) return;
    failedPlayback.current = null;
    const video = event.currentTarget;
    video.currentTime = Math.min(playback.position, video.duration);
    video.playbackRate = playbackRate;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="relative bg-bambu-dark-secondary rounded-xl max-w-4xl w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Film className="w-5 h-5 text-bambu-green" />
            {title}
          </h3>
          <div className="flex items-center gap-2">
            {archiveId && (
              <Button variant="secondary" size="sm" onClick={() => setShowEditor(true)}>
                <Pencil className="w-4 h-4" />
                Edit
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={handleDownload}>
              <Download className="w-4 h-4" />
              Download
            </Button>
            <button
              onClick={onClose}
              className="p-1 hover:bg-bambu-dark-tertiary rounded transition-colors"
            >
              <X className="w-5 h-5 text-bambu-gray" />
            </button>
          </div>
        </div>

        {/* Video */}
        <div className="p-4">
          <video
            ref={videoRef}
            src={initialSource}
            autoPlay
            className="w-full rounded-lg"
            data-manages-media-credential
            onClick={togglePlay}
            onError={handleVideoError}
            onLoadedMetadata={restorePlayback}
          />

          {/* Custom Controls */}
          <div className="mt-4 space-y-3">
            {/* Progress bar */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-bambu-gray w-12 text-right">
                {formatMediaTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="flex-1 h-1 bg-bambu-dark-tertiary rounded-lg appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:bg-bambu-green [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:cursor-pointer"
              />
              <span className="text-xs text-bambu-gray w-12">
                {formatMediaTime(duration)}
              </span>
            </div>

            {/* Playback controls */}
            <div className="flex items-center justify-between">
              {/* Left: Play controls */}
              <div className="flex items-center gap-2">
                <button
                  onClick={skipBackward}
                  className="p-2 hover:bg-bambu-dark-tertiary rounded-lg transition-colors"
                  title="Skip back 5s"
                >
                  <SkipBack className="w-5 h-5 text-bambu-gray" />
                </button>
                <button
                  onClick={togglePlay}
                  className="p-2 bg-bambu-green hover:bg-bambu-green-dark rounded-lg transition-colors"
                >
                  {isPlaying ? (
                    <Pause className="w-5 h-5 text-white" />
                  ) : (
                    <Play className="w-5 h-5 text-white" />
                  )}
                </button>
                <button
                  onClick={skipForward}
                  className="p-2 hover:bg-bambu-dark-tertiary rounded-lg transition-colors"
                  title="Skip forward 5s"
                >
                  <SkipForward className="w-5 h-5 text-bambu-gray" />
                </button>
              </div>

              {/* Right: Speed control */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-bambu-gray">Speed:</span>
                <div className="flex gap-1">
                  {SPEED_OPTIONS.map((speed) => (
                    <button
                      key={speed}
                      onClick={() => setPlaybackRate(speed)}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        playbackRate === speed
                          ? 'bg-bambu-green text-white'
                          : 'bg-bambu-dark-tertiary text-bambu-gray hover:bg-bambu-dark-tertiary/80'
                      }`}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Timelapse Editor Modal */}
      {showEditor && archiveId && (
        <TimelapseEditorModal
          archiveId={archiveId}
          timelapseSrc={src}
          onClose={() => setShowEditor(false)}
          onSave={onEdit}
        />
      )}
    </div>
  );
}
