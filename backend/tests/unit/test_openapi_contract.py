"""Generated OpenAPI surface for frontend-owned API types."""

from backend.app.main import app


def test_frontend_contract_surface():
    schema = app.openapi()
    components = schema["components"]["schemas"]

    assert schema["paths"]["/api/v1/library/files/{file_id}/plates"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/LibraryFilePlatesResponse"}
    assert schema["paths"]["/api/v1/archives/{archive_id}/plates"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/ArchivePlatesResponse"}
    assert "weight_used_baseline" in components["SpoolResponse"]["properties"]
    assert "weight_used_baseline" not in components["SpoolCreate"]["properties"]
    assert "weight_used_baseline" not in components["SpoolUpdate"]["properties"]
