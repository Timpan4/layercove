import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { setMediaToken } from '../../api/client';
import { TimelapseViewer } from '../../components/TimelapseViewer';

it('downloads the video using the current media credential after rotation', () => {
  const url = '/api/v1/archives/5/timelapse';
  let destination: URL | undefined;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    destination = new URL(this.href);
  });
  setMediaToken('old-media-token');
  try {
    render(<TimelapseViewer src={`${url}?token=old-media-token`} title="Fixture timelapse" downloadFilename="print.mp4" onClose={() => {}} />);
    setMediaToken('new-media-token');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(destination?.pathname).toBe(url);
    expect(destination?.searchParams.get('token')).toBe('new-media-token');
  } finally {
    setMediaToken(null);
    click.mockRestore();
  }
});

it('retries a failed video with the current credential and restores the playback position', () => {
  const url = '/api/v1/archives/5/timelapse';
  setMediaToken('old-media-token');
  try {
    const { container } = render(<TimelapseViewer src={`${url}?token=old-media-token`} title="Fixture timelapse" downloadFilename="print.mp4" onClose={() => {}} />);
    const video = container.querySelector('video')!;
    fireEvent.pause(video);
    video.currentTime = 35;
    setMediaToken('new-media-token');
    fireEvent.error(video);
    expect(new URL(video.src).searchParams.get('token')).toBe('new-media-token');

    video.currentTime = 0;
    Object.defineProperty(video, 'duration', { value: 90 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(35);
  } finally {
    setMediaToken(null);
  }
});

it('preserves playback on parent renders and restores a paused seek when a delayed credential arrives', () => {
  const url = '/api/v1/archives/5/timelapse';
  const viewer = (src: string) => <TimelapseViewer src={src} title="Fixture timelapse" downloadFilename="print.mp4" onClose={() => {}} />;
  setMediaToken('old-media-token');
  try {
    const oldSource = `${url}?token=old-media-token&v=1`;
    const { container, rerender } = render(viewer(oldSource));
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: '2x' }));
    fireEvent.pause(video);
    video.currentTime = 35;
    rerender(viewer(`${url}?token=old-media-token&v=2`));
    expect(video.getAttribute('src')).toBe(oldSource);

    fireEvent.error(video);
    expect(video.getAttribute('src')).toBe(oldSource);
    act(() => setMediaToken('new-media-token'));
    expect(new URL(video.src).searchParams.get('token')).toBe('new-media-token');

    video.currentTime = 0;
    video.playbackRate = 1;
    Object.defineProperty(video, 'duration', { value: 90 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(35);
    expect(video.playbackRate).toBe(2);
    expect(video.autoplay).toBe(false);
  } finally {
    act(() => setMediaToken(null));
  }
});
