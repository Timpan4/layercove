import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api, getAuthToken, getMediaToken, getStreamToken, isMediaUrl, setMediaToken, setStreamToken, withMediaToken,
} from '../api/client';
import { useAuth } from '../contexts/AuthContext';

// The plate detection thumbnails use the camera token. Streams and snapshots
// subscribe to the camera query themselves.
function refreshReferenceThumbnails(token: string) {
  const tokenParam = `token=${encodeURIComponent(token)}`;
  document.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img[src*="/api/v1/"], video[src*="/api/v1/"]').forEach((el) => {
    const src = el.getAttribute('src') || '';
    if (!/^\/api\/v1\/printers\/\d+\/camera\/plate-detection\/references\/\d+\/thumbnail(?:[?]|$)/.test(src) || src.includes(tokenParam)) return;
    const withoutToken = src.replace(/([?&])token=[^&]*(&|$)/, (_match, separator, next) => next === '&' ? separator : '');
    el.src = `${withoutToken}${withoutToken.includes('?') ? '&' : '?'}${tokenParam}`;
  });
}

/**
 * Supply the credentials used by same-origin media elements at the app root.
 */
export function useStreamTokenSync() {
  const { authEnabled, user, loading: authLoading, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const refreshingRef = useRef(new Set<string>());

  // Key the token by user id so a login/logout invalidates the cache
  // automatically — otherwise a failed anonymous fetch on the login page
  // would be cached and never retried after sign-in.
  //
  // Race-aware gate (same shape as ColorCatalogProvider): wait for
  // ``checkAuthStatus`` to finish before deciding whether to fetch.
  // The previous form ``authEnabled ? !!user : true`` evaluated to
  // ``true`` on first render because ``authEnabled`` defaults to false,
  // firing a 401 POST on the login page before AuthContext had a chance
  // to settle on ``authEnabled=true, user=null``.
  const { data } = useQuery({
    queryKey: ['camera-stream-token', user?.id ?? null],
    queryFn: () => api.getCameraStreamToken(),
    enabled: !authLoading && (!authEnabled || (user !== null && hasPermission('camera:view'))),
    staleTime: 50 * 60 * 1000, // refresh at 50 min (tokens expire at 60)
    refetchInterval: 50 * 60 * 1000,
  });
  const { data: mediaData } = useQuery({
    queryKey: ['media-token', user?.id ?? null],
    queryFn: () => api.getMediaToken(),
    enabled: !authLoading && authEnabled && user !== null && !getAuthToken()?.startsWith('bb_'),
    staleTime: 50 * 60 * 1000, // refresh at 50 min (tokens expire at 60)
    refetchInterval: 50 * 60 * 1000,
  });

  useEffect(() => {
    const newToken = data?.token ?? null;
    setStreamToken(newToken);
    if (newToken) refreshReferenceThumbnails(newToken);

    return () => setStreamToken(null);
  }, [data?.token]);

  useEffect(() => {
    const token = mediaData?.token ?? null;
    setMediaToken(token);
    if (token) {
      document.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img[src], video[src]').forEach(el => {
        const src = el.getAttribute('src');
        if (!src) return;
        const authorizedSrc = withMediaToken(src);
        if (authorizedSrc !== src) el.setAttribute('src', authorizedSrc);
      });
    }
    return () => setMediaToken(null);
  }, [mediaData?.token]);

  useEffect(() => {
    if (!authEnabled) return;

    const handleError = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement)) return;

      const src = el.src || '';
      const media = isMediaUrl(src);
      const token = media ? getMediaToken() : getStreamToken();
      if (!token || !src.includes(`token=${encodeURIComponent(token)}`)) return;

      const query = media ? 'media-token' : 'camera-stream-token';
      if (refreshingRef.current.has(query)) return;
      // Keep token-owned media mounted while the shared query replaces the
      // stale credential. A repeated failure during that refresh is allowed
      // through to the component's normal error state.
      event.stopPropagation();
      refreshingRef.current.add(query);

      if (media) setMediaToken(null);
      else setStreamToken(null);
      queryClient.setQueriesData({ queryKey: [query] }, undefined);
      queryClient.invalidateQueries({ queryKey: [query] });

      // Reset after a delay so future errors can trigger another refresh
      setTimeout(() => {
        refreshingRef.current.delete(query);
      }, 5000);
    };

    // Use capture phase to catch errors before they're swallowed
    document.addEventListener('error', handleError, true);
    return () => document.removeEventListener('error', handleError, true);
  }, [authEnabled, queryClient]);
}

/**
 * Hook for components that need to wrap URLs with the stream token.
 * Returns a withToken function that appends ?token=xxx when auth is enabled.
 */
export function useCameraStreamToken() {
  const { authEnabled, user, loading: authLoading } = useAuth();
  const { data } = useQuery({
    queryKey: ['camera-stream-token', user?.id ?? null],
    queryFn: () => api.getCameraStreamToken(),
    enabled: !authLoading && (!authEnabled || user !== null),
    staleTime: 50 * 60 * 1000,
    refetchInterval: 50 * 60 * 1000,
  });
  const token = data?.token ?? getStreamToken();
  const withToken = useCallback(
    (url: string) => {
      if (!token) return url;
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}token=${encodeURIComponent(token)}`;
    },
    [token],
  );

  return {
    token,
    waitingForToken: authLoading || ((authEnabled || getAuthToken() !== null) && !token),
    withToken,
  };
}
