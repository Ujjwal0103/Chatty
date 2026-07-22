"""FastAPI sidecar exposing sqlglot validation to the Node services."""
from typing import Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .checks import validate

app = FastAPI(title="chatty-validator", version="0.1.0")


class ValidateRequest(BaseModel):
    sql: str
    allowed_schemas: List[str] = Field(default_factory=lambda: ["warehouse"])
    max_rows: int = 5000
    allowed_tables: Optional[List[str]] = None


class ValidateResponse(BaseModel):
    ok: bool
    fingerprint: Optional[str] = None
    safe_sql: Optional[str] = None
    violations: List[str] = Field(default_factory=list)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/validate", response_model=ValidateResponse)
def validate_sql(req: ValidateRequest) -> ValidateResponse:
    result = validate(req.sql, req.allowed_schemas, req.max_rows, req.allowed_tables)
    return ValidateResponse(
        ok=result.ok,
        fingerprint=result.fingerprint,
        safe_sql=result.safe_sql,
        violations=result.violations,
    )
