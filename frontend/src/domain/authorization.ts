import type { Permission, UserResponse } from '../api/client';

export type AuthorizationDenialReason = 'missing-permission' | 'not-owner';

export type AuthorizationDecision =
  | { allowed: true; reason: null }
  | { allowed: false; reason: AuthorizationDenialReason };

type ResourceActionMap = {
  queue: 'update' | 'delete';
  archives: 'update' | 'delete' | 'reprint';
  library: 'update' | 'delete';
};

export type Resource = keyof ResourceActionMap;
export type ResourceAction<R extends Resource> = ResourceActionMap[R];
export type ArchiveAction = ResourceAction<'archives'>;
export type LibraryFileAction = ResourceAction<'library'>;

export interface AuthorizationSession {
  authEnabled: boolean;
  user: Pick<UserResponse, 'id' | 'is_admin' | 'permissions'> | null;
}

export interface AuthorizationPolicy {
  isAdmin: boolean;
  permission: (permission: Permission) => AuthorizationDecision;
  anyPermission: (...permissions: Permission[]) => AuthorizationDecision;
  allPermissions: (...permissions: Permission[]) => AuthorizationDecision;
  route: (permission: Permission) => AuthorizationDecision;
  resourceAction: <R extends Resource>(resource: R, action: ResourceAction<R>, createdById: number | null | undefined) => AuthorizationDecision;
  archiveAction: (action: ArchiveAction, createdById: number | null | undefined) => AuthorizationDecision;
  libraryFileAction: (action: LibraryFileAction, createdById: number | null | undefined) => AuthorizationDecision;
}

const allowed: AuthorizationDecision = { allowed: true, reason: null };
const missingPermission: AuthorizationDecision = { allowed: false, reason: 'missing-permission' };
const notOwner: AuthorizationDecision = { allowed: false, reason: 'not-owner' };

const actionPermissions = {
  queue: {
    update: ['queue:update_all', 'queue:update_own'],
    delete: ['queue:delete_all', 'queue:delete_own'],
  },
  archives: {
    update: ['archives:update_all', 'archives:update_own'],
    delete: ['archives:delete_all', 'archives:delete_own'],
    reprint: ['archives:reprint_all', 'archives:reprint_own'],
  },
  library: {
    update: ['library:update_all', 'library:update_own'],
    delete: ['library:delete_all', 'library:delete_own'],
  },
} as const satisfies { [R in Resource]: Record<ResourceAction<R>, readonly [Permission, Permission]> };

export function createAuthorization(session: AuthorizationSession): AuthorizationPolicy {
  const permissions = new Set(session.user?.permissions);
  const isAdmin = !session.authEnabled || session.user?.is_admin === true;

  const permission = (value: Permission): AuthorizationDecision =>
    isAdmin || permissions.has(value) ? allowed : missingPermission;

  const anyPermission = (...values: Permission[]): AuthorizationDecision =>
    isAdmin || values.some((value) => permissions.has(value)) ? allowed : missingPermission;

  const allPermissions = (...values: Permission[]): AuthorizationDecision =>
    isAdmin || values.every((value) => permissions.has(value)) ? allowed : missingPermission;

  const resourceAction = <R extends Resource>(
    resource: R,
    action: ResourceAction<R>,
    createdById: number | null | undefined,
  ): AuthorizationDecision => {
    const actionPermission = actionPermissions[resource][action as never] as readonly [Permission, Permission] | undefined;
    if (!actionPermission) return missingPermission;
    if (isAdmin) return allowed;

    const [allPermission, ownPermission] = actionPermission;
    if (permissions.has(allPermission)) return allowed;
    if (!permissions.has(ownPermission)) return missingPermission;
    return createdById != null && createdById === session.user?.id ? allowed : notOwner;
  };

  return {
    isAdmin,
    permission,
    anyPermission,
    allPermissions,
    route: permission,
    resourceAction,
    archiveAction: (action, createdById) => resourceAction('archives', action, createdById),
    libraryFileAction: (action, createdById) => resourceAction('library', action, createdById),
  };
}
