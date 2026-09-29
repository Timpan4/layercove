import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setStreamToken, getAuthToken, getStreamToken } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

// Camera components subscribe to the token. Legacy thumbnail consumers still
// need their existing media refreshed when the shared token arrives.
function refreshThumbnailTokens(token: string) {
  const tokenParam = `token=${encodeURIComponent(token)}`;
  document.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img[src*="/api/v1/"], video[src*="/api/v1/"]').forEach((el) => {
    const src = el.getAttribute('src') || '';
    if (/\/api\/v1\/printers\/\d+\/(?:camera|cameras\/\d+)\//.test(src) || src.includes(tokenParam)) return;
    const withoutToken = src.replace(/([?&])token=[^&]*(&|$)/, (_match, separator, next) => next === '&' ? separator : '');
    el.src = `${withoutToken}${withoutToken.includes('?') ? '&' : '?'}${tokenParam}`;
  });
}

/**
 * Fetches and caches a stream token for <img>/<video> src URLs.
 * Stores the token globally via setStreamToken() so URL generators
 * in client.ts can use withStreamToken() automatically.
 *
 * Also listens for global image load errors on token-protected URLs
 * and automatically refreshes the token (e.g., after backend restart
 * invalidates in-memory tokens).
 *
 * Mount this hook once near the app root (e.g., in App.tsx or a layout component).
 * Components that need token-protected URLs can import withStreamToken directly.
 */
export function useStreamTokenSync() {
  const { authEnabled, user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const refreshingRef = useRef(false);

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
    enabled: !authLoading && (!authEnabled || user !== null),
    staleTime: 50 * 60 * 1000, // refresh at 50 min (tokens expire at 60)
    refetchInterval: 50 * 60 * 1000,
  });

  useEffect(() => {
    const newToken = data?.token ?? null;
    setStreamToken(newToken);
    if (newToken) refreshThumbnailTokens(newToken);

    return () => setStreamToken(null);
  }, [data?.token]);

  // Listen for image/video load errors on token-protected URLs.
  // When the backend restarts, in-memory stream tokens are lost and all
  // thumbnail/stream requests return 401. This handler detects that and
  // forces a token refresh so images recover without a page reload.
  useEffect(() => {
    if (!authEnabled) return;

    const handleError = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement)) return;

      const src = el.src || '';
      const token = getStreamToken();
      if (!token || !src.includes(`token=${encodeURIComponent(token)}`)) return;

      if (refreshingRef.current) return;
      // Keep token-owned media mounted while the shared query replaces the
      // stale credential. A repeated failure during that refresh is allowed
      // through to the component's normal error state.
      event.stopPropagation();
      refreshingRef.current = true;

      setStreamToken(null);
      queryClient.setQueriesData({ queryKey: ['camera-stream-token'] }, undefined);
      queryClient.invalidateQueries({ queryKey: ['camera-stream-token'] });

      // Reset after a delay so future errors can trigger another refresh
      setTimeout(() => {
        refreshingRef.current = false;
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
