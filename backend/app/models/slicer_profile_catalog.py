"""Persistent installed-printer slicer profile catalog."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    false,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class SlicerProfileAccount(Base):
    __tablename__ = "slicer_profile_accounts"
    __table_args__ = (
        UniqueConstraint("source", "remote_account_id", name="uq_slicer_profile_accounts_source_remote"),
        CheckConstraint(
            "source IN ('local', 'orca_cloud', 'cloud', 'standard')",
            name="ck_slicer_profile_accounts_source",
        ),
        CheckConstraint(
            "sharing_state IN ('private', 'pending', 'shared')",
            name="ck_slicer_profile_accounts_sharing_state",
        ),
        CheckConstraint(
            "sharing_state != 'shared' OR consent_at IS NOT NULL",
            name="ck_slicer_profile_accounts_shared_consent",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    source: Mapped[str] = mapped_column(String(32))
    remote_account_id: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(255))
    sharing_state: Mapped[str] = mapped_column(String(16), default="private", server_default="private")
    consent_at: Mapped[datetime | None] = mapped_column(DateTime)
    sync_cursor: Mapped[str | None] = mapped_column(Text)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_successful_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_sync_error: Mapped[str | None] = mapped_column(Text)
    sync_frozen: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SlicerProfileReviewBatch(Base):
    __tablename__ = "slicer_profile_review_batches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'superseded')",
            name="ck_slicer_profile_review_batches_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("slicer_profile_accounts.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    sync_cursor_before: Mapped[str | None] = mapped_column(Text)
    sync_cursor_after: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    reviewed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerProfile(Base):
    __tablename__ = "slicer_profiles"
    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "remote_profile_id",
            "profile_type",
            name="uq_slicer_profiles_stable_identity",
        ),
        CheckConstraint(
            "profile_type IN ('printer', 'process', 'filament')",
            name="ck_slicer_profiles_profile_type",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("slicer_profile_accounts.id", ondelete="CASCADE"), index=True)
    remote_profile_id: Mapped[str] = mapped_column(String(512))
    profile_type: Mapped[str] = mapped_column(String(16))
    display_name: Mapped[str] = mapped_column(String(512))
    tombstoned_at: Mapped[datetime | None] = mapped_column(DateTime)
    stale_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SlicerProfileRevision(Base):
    __tablename__ = "slicer_profile_revisions"
    __table_args__ = (
        UniqueConstraint("profile_id", "content_hash", name="uq_slicer_profile_revisions_content"),
        CheckConstraint(
            "review_state IN ('pending', 'approved', 'rejected')",
            name="ck_slicer_profile_revisions_review_state",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="CASCADE"), index=True)
    review_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profile_review_batches.id", ondelete="SET NULL"), index=True
    )
    remote_revision_id: Mapped[str | None] = mapped_column(String(512))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    content_hash: Mapped[str] = mapped_column(String(128))
    content: Mapped[dict[str, Any]] = mapped_column(JSON)
    resolved_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    review_state: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerProfileActivation(Base):
    __tablename__ = "slicer_profile_activations"
    __table_args__ = (UniqueConstraint("profile_id", name="uq_slicer_profile_activations_profile"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="CASCADE"))
    revision_id: Mapped[int] = mapped_column(ForeignKey("slicer_profile_revisions.id", ondelete="RESTRICT"), index=True)
    activated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    activated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerProfileActivationEvent(Base):
    __tablename__ = "slicer_profile_activation_events"
    __table_args__ = (
        CheckConstraint("action IN ('activate', 'rollback')", name="ck_slicer_profile_activation_events_action"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="CASCADE"), index=True)
    revision_id: Mapped[int] = mapped_column(
        ForeignKey("slicer_profile_revisions.id", ondelete="RESTRICT"), index=True
    )
    action: Mapped[str] = mapped_column(String(16))
    activated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    activated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PrinterSlicerBinding(Base):
    __tablename__ = "printer_slicer_bindings"
    __table_args__ = (
        UniqueConstraint(
            "printer_id",
            "profile_id",
            "expected_nozzle_diameter",
            "tool_index",
            name="uq_printer_slicer_bindings_exact",
        ),
        CheckConstraint("expected_nozzle_diameter > 0", name="ck_printer_slicer_bindings_nozzle"),
        CheckConstraint("tool_index >= 0", name="ck_printer_slicer_bindings_tool"),
        CheckConstraint(
            "enforcement_state IN ('shadow', 'enforced')",
            name="ck_printer_slicer_bindings_enforcement",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="RESTRICT"), index=True)
    expected_nozzle_diameter: Mapped[Decimal] = mapped_column(Numeric(4, 2))
    tool_index: Mapped[int] = mapped_column(default=0, server_default="0")
    default_process_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profiles.id", ondelete="SET NULL")
    )
    default_filament_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profiles.id", ondelete="SET NULL")
    )
    enforcement_state: Mapped[str] = mapped_column(String(16), default="shadow", server_default="shadow")
    confirmed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerCompatibilityMapping(Base):
    __tablename__ = "slicer_compatibility_mappings"
    __table_args__ = (UniqueConstraint("profile_id", "printer_id", name="uq_slicer_compatibility_mappings_target"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="CASCADE"), index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerFilamentRule(Base):
    __tablename__ = "slicer_filament_rules"
    __table_args__ = (
        CheckConstraint(
            "scope IN ('exact_external', 'signature')",
            name="ck_slicer_filament_rules_scope",
        ),
        CheckConstraint(
            "nozzle_diameter_min IS NULL OR nozzle_diameter_max IS NULL OR nozzle_diameter_min <= nozzle_diameter_max",
            name="ck_slicer_filament_rules_nozzle_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(32))
    external_source: Mapped[str | None] = mapped_column(String(64))
    external_identity: Mapped[str | None] = mapped_column(String(255))
    filament_profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="CASCADE"), index=True)
    binding_id: Mapped[int | None] = mapped_column(
        ForeignKey("printer_slicer_bindings.id", ondelete="CASCADE"), index=True
    )
    printer_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profiles.id", ondelete="CASCADE"), index=True
    )
    material_type: Mapped[str | None] = mapped_column(String(128))
    vendor: Mapped[str | None] = mapped_column(String(255))
    nozzle_diameter_min: Mapped[Decimal | None] = mapped_column(Numeric(4, 2))
    nozzle_diameter_max: Mapped[Decimal | None] = mapped_column(Numeric(4, 2))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class UserSlicerPreference(Base):
    __tablename__ = "user_slicer_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", "binding_id", "preference_key", name="uq_user_slicer_preferences_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    binding_id: Mapped[int] = mapped_column(ForeignKey("printer_slicer_bindings.id", ondelete="CASCADE"), index=True)
    preference_key: Mapped[str] = mapped_column(String(64))
    value: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SlicerSelectionEvaluation(Base):
    __tablename__ = "slicer_selection_evaluations"
    __table_args__ = (
        CheckConstraint(
            "readiness_state IN ('ready', 'acknowledgement_required', 'blocked')",
            name="ck_slicer_selection_evaluations_readiness",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="RESTRICT"), index=True)
    binding_id: Mapped[int | None] = mapped_column(ForeignKey("printer_slicer_bindings.id", ondelete="SET NULL"))
    readiness_state: Mapped[str] = mapped_column(String(32))
    selected_revision_ids: Mapped[dict[str, Any]] = mapped_column(JSON)
    compatibility_evidence: Mapped[dict[str, Any]] = mapped_column(JSON)
    nozzle_evidence: Mapped[dict[str, Any]] = mapped_column(JSON)
    acknowledgement: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SlicerJobProvenance(Base):
    __tablename__ = "slicer_job_provenance"
    __table_args__ = (
        UniqueConstraint("slice_job_id", name="uq_slicer_job_provenance_job"),
        CheckConstraint(
            "provenance_state IN ('provenance_unknown', 'resolved')",
            name="ck_slicer_job_provenance_state",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    slice_job_id: Mapped[int] = mapped_column(ForeignKey("slice_jobs.id", ondelete="CASCADE"), index=True)
    provenance_state: Mapped[str] = mapped_column(String(32))
    selection_evaluation_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_selection_evaluations.id", ondelete="SET NULL"), unique=True
    )
    printer_revision_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profile_revisions.id", ondelete="RESTRICT")
    )
    process_revision_id: Mapped[int | None] = mapped_column(
        ForeignKey("slicer_profile_revisions.id", ondelete="RESTRICT")
    )
    filament_revision_ids: Mapped[list[int] | None] = mapped_column(JSON)
    selection_evidence: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
