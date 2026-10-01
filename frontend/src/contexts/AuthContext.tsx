import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, getAuthToken, isInvalidTokenError, setAuthToken } from '../api/client';
import type { LoginResponse, Permission, TokenPersistence, UserResponse } from '../api/client';
import { createAuthorization, type ArchiveAction, type AuthorizationDecision, type AuthorizationPolicy, type LibraryFileAction, type Resource, type ResourceAction } from '../domain/authorization';

interface AuthContextType {
  user: UserResponse | null;
  authEnabled: boolean;
  requiresSetup: boolean;
  loading: boolean;
  authUnavailable: boolean;
  isAdmin: boolean;
  /** Login with username/password. Returns LoginResponse (may include requires_2fa). */
  login: (username: string, password: string, persistence?: TokenPersistence) => Promise<LoginResponse>;
  /** Finalise login after 2FA or OIDC — store token and set user directly. */
  loginWithToken: (token: string, user: UserResponse, persistence?: TokenPersistence) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  authorization: AuthorizationPolicy;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (...permissions: Permission[]) => boolean;
  hasAllPermissions: (...permissions: Permission[]) => boolean;
  canModify: <R extends Resource>(resource: R, action: ResourceAction<R>, createdById: number | null | undefined) => boolean;
  canArchiveAction: (action: ArchiveAction, createdById: number | null | undefined) => AuthorizationDecision;
  canLibraryFileAction: (action: LibraryFileAction, createdById: number | null | undefined) => AuthorizationDecision;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const PENDING_KIOSK_TOKEN_KEY = 'auth_pending_kiosk_token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [requiresSetup, setRequiresSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const hasRedirectedRef = useRef(false);
  const mountedRef = useRef(true);
  const authCheckIdRef = useRef(0);
  const pendingKioskTokenRef = useRef<string | null>(null);

  const savePendingKioskToken = (token: string | null) => {
    pendingKioskTokenRef.current = token;
    try {
      if (token) sessionStorage.setItem(PENDING_KIOSK_TOKEN_KEY, token);
      else sessionStorage.removeItem(PENDING_KIOSK_TOKEN_KEY);
    } catch {
      // Keep the candidate in memory when browser storage is unavailable.
    }
  };

  const checkAuthStatus = async () => {
    const checkId = ++authCheckIdRef.current;
    const isCurrentCheck = () => mountedRef.current && checkId === authCheckIdRef.current;
    setLoading(true);
    setAuthUnavailable(false);
    try {
      // SpoolBuddy kiosk links can pass an API key on first load. Strip it
      // from the URL and validate it without replacing stored credentials.
      // Persist only after the server accepts it, preventing session fixation
      // and preserving a remembered login when the link is invalid or unavailable.
      const urlParams = new URLSearchParams(window.location.search);
      let urlToken = urlParams.get('token') ?? pendingKioskTokenRef.current;
      try {
        urlToken ??= sessionStorage.getItem(PENDING_KIOSK_TOKEN_KEY);
      } catch {
        // In-memory recovery still works when browser storage is unavailable.
      }
      if (urlToken) {
        savePendingKioskToken(urlToken);
        urlParams.delete('token');
        const cleanSearch = urlParams.toString();
        const cleanUrl = window.location.pathname
          + (cleanSearch ? `?${cleanSearch}` : '')
          + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }

      const status = await api.getAuthStatus();
      if (!isCurrentCheck()) return;
      setAuthEnabled(status.auth_enabled);
      setRequiresSetup(status.requires_setup);

      if (status.auth_enabled) {
        const token = urlToken ?? getAuthToken();
        if (token) {
          // Validate the stored token. A transient failure here (backend not
          // yet ready after a container/proxy restart, a brief network blip)
          // must NOT discard a valid persisted token — doing so logs the user
          // out and, because the token is deleted, a reload can't recover it
          // (#1889). Only a definitive 401 invalid-token response clears the
          // token, and `request()` already does that clearing + dispatches
          // `auth:expired`; here we just retry the transient cases and keep the
          // token so the session survives a slow load.
          let currentUser: UserResponse | null = null;
          let definitiveAuthFailure = false;
          const maxAttempts = 3;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              currentUser = await api.getCurrentUser(token);
              break;
            } catch (err) {
              if (!isCurrentCheck()) return;
              // 401 invalid-token → genuinely logged out. `request()` has
              // already cleared the token; stop retrying.
              if (isInvalidTokenError(err)) {
                definitiveAuthFailure = true;
                break;
              }
              // Transient (network / 5xx / other) → back off and retry. Leave
              // the token in place so a subsequent load can recover.
              if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, 400 * attempt));
              }
            }
          }
          if (!isCurrentCheck()) return;
          if (currentUser) {
            setUser(currentUser);
            // Persist kiosk token only after the server confirms it is valid.
            if (urlToken && token === urlToken) {
              setAuthToken(urlToken, 'persistent');
              savePendingKioskToken(null);
            }
          } else {
            // No user: either a definitive 401 (token already cleared by
            // request()) or transient failures exhausted their retries. In the
            // transient case we deliberately keep the token so a reload retries
            // rather than forcing a re-login.
            if (definitiveAuthFailure) {
              if (urlToken) savePendingKioskToken(null);
              if (token === getAuthToken()) setAuthToken(null);
              setUser(null);
            } else {
              setAuthUnavailable(true);
            }
          }
        } else {
          setUser(null);
        }
      } else {
        // Auth not enabled, allow access
        setUser(null);
      }
    } catch {
      if (!isCurrentCheck()) return;
      setAuthUnavailable(true);
    } finally {
      if (isCurrentCheck()) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    // Check auth status on mount
    checkAuthStatus();

    // Listen for token-expiry events from the API client. setAuthToken(null)
    // in client.ts only clears storage; without this listener, `user` stays
    // populated and ProtectedRoute keeps rendering the protected tree until a
    // manual refresh — every request silently fails in the meantime (#1698).
    const handleAuthExpired = () => {
      if (!mountedRef.current) return;
      setUser(null);
      setAuthUnavailable(false);
    };
    window.addEventListener('auth:expired', handleAuthExpired);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('auth:expired', handleAuthExpired);
    };
  }, []);

  // Separate effect to handle redirect only when setup is required
  useEffect(() => {
    // Only redirect if setup is truly required (first time setup)
    // Don't redirect if user manually navigated to /setup or is on camera page
    if (!loading && requiresSetup && !authEnabled) {
      const currentPath = window.location.pathname;
      // Only redirect if not already on setup page or camera page, and haven't redirected yet
      if (currentPath !== '/setup' && !currentPath.startsWith('/camera/') && !hasRedirectedRef.current) {
        hasRedirectedRef.current = true;
        window.location.href = '/setup';
      }
    } else if (!requiresSetup) {
      // Reset redirect flag when setup is no longer required
      hasRedirectedRef.current = false;
    }
  }, [loading, requiresSetup, authEnabled]);

  const login = async (username: string, password: string, persistence: TokenPersistence = 'session'): Promise<LoginResponse> => {
    const response = await api.login({ username, password });
    if (!response.requires_2fa && response.access_token) {
      savePendingKioskToken(null);
      setAuthToken(response.access_token, persistence);
      await checkAuthStatus();
    }
    return response;
  };

  const loginWithToken = (token: string, userObj: UserResponse, persistence: TokenPersistence = 'session') => {
    authCheckIdRef.current++;
    savePendingKioskToken(null);
    setAuthToken(token, persistence);
    setUser(userObj);
    setAuthEnabled(true);
    setAuthUnavailable(false);
    setLoading(false);
  };

  const logout = () => {
    savePendingKioskToken(null);
    setAuthToken(null);
    setUser(null);
    api.logout().catch(() => {
      // Ignore logout errors
    });
    window.location.href = '/login';
  };

  const refreshUser = async () => {
    if (authEnabled && getAuthToken()) {
      try {
        const currentUser = await api.getCurrentUser();
        if (mountedRef.current) {
          setUser(currentUser);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (isInvalidTokenError(err)) {
          setAuthToken(null);
          setUser(null);
        } else {
          setAuthUnavailable(true);
        }
      }
    }
  };

  const refreshAuth = async () => {
    await checkAuthStatus();
  };

  const authorization = useMemo(() => createAuthorization({ authEnabled, user }), [authEnabled, user]);
  const isAdmin = authorization.isAdmin;
  const hasPermission = useCallback((permission: Permission) => authorization.permission(permission).allowed, [authorization]);
  const hasAnyPermission = useCallback((...permissions: Permission[]) => authorization.anyPermission(...permissions).allowed, [authorization]);
  const hasAllPermissions = useCallback((...permissions: Permission[]) => authorization.allPermissions(...permissions).allowed, [authorization]);
  const canModify = useCallback(<R extends Resource>(
    resource: R,
    action: ResourceAction<R>,
    createdById: number | null | undefined,
  ) => authorization.resourceAction(resource, action, createdById).allowed, [authorization]);
  const canArchiveAction = useCallback((action: ArchiveAction, createdById: number | null | undefined) => authorization.archiveAction(action, createdById), [authorization]);
  const canLibraryFileAction = useCallback((action: LibraryFileAction, createdById: number | null | undefined) => authorization.libraryFileAction(action, createdById), [authorization]);

  return (
    <AuthContext.Provider
      value={{
        user,
        authEnabled,
        requiresSetup,
        loading,
        authUnavailable,
        isAdmin,
        authorization,
        login,
        loginWithToken,
        logout,
        refreshUser,
        refreshAuth,
        hasPermission,
        hasAnyPermission,
        hasAllPermissions,
        canModify,
        canArchiveAction,
        canLibraryFileAction,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
