"""Caller identity and authorization decisions shared by route dependencies."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from backend.app.core.permissions import Permission

if TYPE_CHECKING:
    from backend.app.models.api_key import APIKey
    from backend.app.models.user import User


class CallerKind(str, Enum):
    AUTH_DISABLED = "auth_disabled"
    API_KEY = "api_key"
    USER = "user"


@dataclass(frozen=True, slots=True)
class PermissionDecision:
    allowed: bool
    denial_reason: str | None = None


@dataclass(frozen=True, slots=True)
class OwnershipDecision:
    can_access_all: bool
    owner_id: int | None
    denial_reason: str | None = None


@dataclass(frozen=True, slots=True)
class CallerIdentity:
    """Authenticated user, API key, or auth-disabled caller.

    API keys deliberately expose no row-ownership identity, even when their
    model row has a user_id for unrelated cloud access.
    """

    kind: CallerKind
    user: User | None = None
    api_key: APIKey | None = None

    @classmethod
    def auth_disabled(cls) -> CallerIdentity:
        return cls(CallerKind.AUTH_DISABLED)

    @classmethod
    def authenticated_user(cls, user: User) -> CallerIdentity:
        return cls(CallerKind.USER, user=user)

    @classmethod
    def authenticated_api_key(cls, api_key: APIKey) -> CallerIdentity:
        return cls(CallerKind.API_KEY, api_key=api_key)

    @property
    def owner_id(self) -> int | None:
        return self.user.id if self.kind is CallerKind.USER and self.user is not None else None

    @property
    def printer_ids(self) -> list[int] | None:
        """Return an API key's printer scope; None permits every printer."""
        return self.api_key.printer_ids if self.kind is CallerKind.API_KEY and self.api_key is not None else None

    def permission_decision(self, *permissions: Permission, require_any: bool = False) -> PermissionDecision:
        perm_strings = [permission.value for permission in permissions]
        if self.kind is CallerKind.AUTH_DISABLED:
            return PermissionDecision(True)
        if self.kind is CallerKind.USER and self.user is not None:
            allowed = (
                self.user.has_any_permission(*perm_strings)
                if require_any
                else self.user.has_all_permissions(*perm_strings)
            )
            return PermissionDecision(
                allowed,
                None if allowed else f"Missing required permissions: {', '.join(perm_strings)}",
            )
        if self.kind is CallerKind.API_KEY and self.api_key is not None:
            # Import lazily: auth creates CallerIdentity instances.
            from backend.app.core.auth import _check_apikey_permissions

            try:
                _check_apikey_permissions(self.api_key, perm_strings, require_any=require_any)
            except HTTPException as error:
                return PermissionDecision(False, str(error.detail))
            return PermissionDecision(True)
        return PermissionDecision(False, "Authentication required")

    def require_permissions(self, *permissions: Permission, require_any: bool = False) -> None:
        decision = self.permission_decision(*permissions, require_any=require_any)
        if not decision.allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=decision.denial_reason)

    def ownership_decision(self, all_permission: Permission, own_permission: Permission) -> OwnershipDecision:
        if self.kind in {CallerKind.AUTH_DISABLED, CallerKind.API_KEY}:
            self.require_permissions(all_permission)
            return OwnershipDecision(True, None)
        if self.user is not None:
            if self.user.has_permission(all_permission.value):
                return OwnershipDecision(True, self.user.id)
            if self.user.has_permission(own_permission.value):
                return OwnershipDecision(False, self.user.id)
        return OwnershipDecision(
            False,
            self.owner_id,
            f"Missing permission: {own_permission.value} or {all_permission.value}",
        )

    def require_ownership(self, all_permission: Permission, own_permission: Permission) -> OwnershipDecision:
        decision = self.ownership_decision(all_permission, own_permission)
        if decision.denial_reason:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=decision.denial_reason)
        return decision

    def require_printer_access(self, printer_id: int | None) -> None:
        if self.printer_ids is not None and printer_id not in self.printer_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API key does not have access to printer {printer_id}",
            )
