import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Permission } from '../../api/client';
import { createAuthorization } from '../../domain/authorization';

function policy({
  authEnabled = true,
  id = 7,
  isAdmin = false,
  permissions = [],
}: {
  authEnabled?: boolean;
  id?: number;
  isAdmin?: boolean;
  permissions?: Permission[];
} = {}) {
  return createAuthorization({
    authEnabled,
    user: { id, is_admin: isAdmin, permissions },
  });
}

describe('authorization', () => {
  it('allows supported actions for admins and when auth is disabled', () => {
    expect(policy({ isAdmin: true }).archiveAction('delete', null)).toEqual({ allowed: true, reason: null });
    expect(policy({ authEnabled: false, id: 0 }).libraryFileAction('update', null)).toEqual({ allowed: true, reason: null });
  });

  it('allows all permissions and only the user’s owned actions', () => {
    expect(policy({ permissions: ['archives:update_all'] }).archiveAction('update', 8)).toEqual({ allowed: true, reason: null });
    expect(policy({ permissions: ['archives:update_own'] }).archiveAction('update', 7)).toEqual({ allowed: true, reason: null });
    expect(policy({ permissions: ['archives:update_own'] }).archiveAction('update', 8)).toEqual({ allowed: false, reason: 'not-owner' });
  });

  it('denies ownerless actions and missing permissions with their reasons', () => {
    expect(policy({ permissions: ['archives:delete_own'] }).archiveAction('delete', null)).toEqual({ allowed: false, reason: 'not-owner' });
    expect(policy().archiveAction('delete', 7)).toEqual({ allowed: false, reason: 'missing-permission' });
  });

  it('rejects unsupported actions, including unchecked runtime input', () => {
    const authorization = policy({ isAdmin: true });

    expectTypeOf<Parameters<typeof authorization.libraryFileAction>[0]>().not.toEqualTypeOf<'reprint'>();
    expect(authorization.resourceAction('library', 'reprint' as never, 7)).toEqual({ allowed: false, reason: 'missing-permission' });
  });
});
