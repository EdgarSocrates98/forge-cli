#!/usr/bin/env python3
# forge_contracts.py — forge/<Name>/v1 contract validator (stdlib-only, vendored).
#
# Byte-parity vendored module: any Forge may ship this file verbatim as
# `<pkg>/_forge_contracts.py`. It validates dicts against the canonical
# `forge/*` schemas without jsonschema or any third-party dependency —
# a deliberately small subset of draft-07 sufficient for these contracts:
#   type, required, properties, additionalProperties, enum, const, pattern,
#   items, $ref (internal forge/<Name>/v1), minLength, maxLength, min, max.
#
# Compatibility rules (see contracts/CONTRACTS.md):
#   - unknown fields are tolerated (additionalProperties default true at
#     every level of these schemas)
#   - `schema` mismatch → CONTRACT-VERSION error, never coerced
#   - malformed input → structured error list, never exceptions on data
#
# Selftest:  python forge_contracts.py --selftest

from __future__ import annotations

import json
import re
from typing import Any

SCHEMA_NS = "forge/"

_CONTRACTS: dict[str, dict] = {}


def _load() -> dict[str, dict]:
    """Embedded canonical schemas — regenerated from contracts/schemas/*.json
    by `python forge_contracts.py --embed <dir>`; kept inline so the vendored
    file stays single-file and dependency-free."""
    if _CONTRACTS:
        return _CONTRACTS
    _CONTRACTS.update(EMBEDDED)
    return _CONTRACTS


# ---------------------------------------------------------------------------
# errors


class ContractError(ValueError):
    """Structured validation error; `path` is the JSON pointer of the fault."""

    def __init__(self, code: str, message: str, path: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.path = path

    def body(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "path": self.path}


class SchemaVersionError(ContractError):
    pass


# ---------------------------------------------------------------------------
# validator


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _type_ok(value: Any, spec: Any) -> bool:
    if isinstance(spec, list):
        return any(_type_ok(value, t) for t in spec)
    fn = _TYPE_CHECKS.get(spec)
    return bool(fn and fn(value))


def _check(value: Any, schema: dict, path: str, errs: list[ContractError]) -> None:
    if "$ref" in schema:
        target = schema["$ref"]
        if not target.startswith(SCHEMA_NS):
            errs.append(ContractError("CONTRACT-REF", f"external ref refused: {target}", path))
            return
        resolved = _load().get(target)
        if resolved is None:
            errs.append(ContractError("CONTRACT-UNKNOWN", f"unknown contract: {target}", path))
            return
        _check(value, resolved, path, errs)
        return

    if "const" in schema and value != schema["const"]:
        errs.append(ContractError("CONTRACT-CONST", f"expected {schema['const']!r}", path))
        return

    if "type" in schema and not _type_ok(value, schema["type"]):
        errs.append(
            ContractError("CONTRACT-TYPE", f"expected type {schema['type']}", path)
        )
        return

    if "enum" in schema and value not in schema["enum"]:
        errs.append(
            ContractError("CONTRACT-ENUM", f"value not in {schema['enum']}", path)
        )
        return

    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(
                ContractError("CONTRACT-PATTERN", f"does not match {schema['pattern']}", path)
            )
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append(ContractError("CONTRACT-LENGTH", "string too short", path))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append(ContractError("CONTRACT-LENGTH", "string too long", path))

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "min" in schema and value < schema["min"]:
            errs.append(ContractError("CONTRACT-RANGE", f"< {schema['min']}", path))
        if "max" in schema and value > schema["max"]:
            errs.append(ContractError("CONTRACT-RANGE", f"> {schema['max']}", path))

    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                errs.append(
                    ContractError("CONTRACT-REQUIRED", f"missing '{req}'", f"{path}/{req}")
                )
        props = schema.get("properties", {})
        for key, val in value.items():
            if key in props:
                _check(val, props[key], f"{path}/{key}", errs)
            elif schema.get("additionalProperties") is False:
                errs.append(
                    ContractError("CONTRACT-UNKNOWN-FIELD", f"unexpected '{key}'", f"{path}/{key}")
                )
            elif isinstance(schema.get("additionalProperties"), dict):
                _check(val, schema["additionalProperties"], f"{path}/{key}", errs)
        if "minProperties" in schema and len(value) < schema["minProperties"]:
            errs.append(ContractError("CONTRACT-SIZE", "too few properties", path))

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append(ContractError("CONTRACT-SIZE", "too few items", path))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(value):
                _check(item, item_schema, f"{path}/{i}", errs)


def validate(contract_id: str, document: dict) -> list[ContractError]:
    """Validate `document` against `contract_id` (e.g. 'forge/ForgeDescriptor/v1').
    Returns a list of structured errors — empty means valid. Never raises on data."""
    schema = _load().get(contract_id)
    if schema is None:
        return [ContractError("CONTRACT-UNKNOWN", f"unknown contract: {contract_id}")]
    if not isinstance(document, dict):
        return [ContractError("CONTRACT-TYPE", "document must be a JSON object", "")]
    declared = document.get("schema")
    if declared is not None and declared != contract_id:
        return [
            SchemaVersionError(
                "CONTRACT-VERSION", f"document declares {declared!r}, expected {contract_id!r}"
            )
        ]
    errs: list[ContractError] = []
    _check(document, schema, "", errs)
    return errs


def validate_document(document: dict) -> list[ContractError]:
    """Validate against the contract named by document['schema']."""
    declared = document.get("schema") if isinstance(document, dict) else None
    if not isinstance(declared, str) or not declared.startswith(SCHEMA_NS):
        return [
            SchemaVersionError(
                "CONTRACT-VERSION", "document must declare a 'forge/<Name>/vN' schema"
            )
        ]
    return validate(declared, document)


def is_compatible(contract_id: str, document: dict) -> bool:
    """Additive-only rule: a document is compatible when every error is an
    unknown-field issue *never raised by these schemas* — i.e. validate()
    must return empty. Kept for API symmetry with the TS validator."""
    return not validate(contract_id, document)


# ---------------------------------------------------------------------------
# embedded schemas (generated — keep in sync with contracts/schemas/*.json)

EMBEDDED: dict[str, dict] = {'forge/ForgeCapability/v1': {'$id': 'forge/ForgeCapability/v1',
                              '$schema': 'http://json-schema.org/draft-07/schema#',
                              'additionalProperties': True,
                              'properties': {'detail': {'type': ['string', 'null']},
                                             'evidence': {'type': ['string', 'null']},
                                             'id': {'pattern': '^[a-z][a-z0-9_.-]{0,63}$', 'type': 'string'},
                                             'label_key': {'type': 'string'},
                                             'requires': {'items': {'type': 'string'}, 'type': 'array'},
                                             'schema': {'const': 'forge/ForgeCapability/v1'},
                                             'since': {'type': ['string', 'null']},
                                             'state': {'enum': ['supported',
                                                                'unverified',
                                                                'unsupported',
                                                                'not_applicable']}},
                              'required': ['id', 'state'],
                              'title': 'ForgeCapability',
                              'type': 'object'},
 'forge/ForgeDescriptor/v1': {'$id': 'forge/ForgeDescriptor/v1',
                              '$schema': 'http://json-schema.org/draft-07/schema#',
                              'additionalProperties': True,
                              'properties': {'capabilities': {'items': {'$ref': 'forge/ForgeCapability/v1'},
                                                              'type': 'array'},
                                             'cli': {'pattern': '^[A-Za-z0-9_-]+$',
                                                     'type': ['string', 'null']},
                                             'env_schema': {'$ref': 'forge/ForgeEnvironmentSchema/v1'},
                                             'forge_id': {'pattern': '^[a-z][a-z0-9-]{0,62}[a-z0-9]$',
                                                          'type': 'string'},
                                             'install': {'$ref': 'forge/ForgeInstallContract/v1'},
                                             'kind': {'enum': ['python', 'node', 'other']},
                                             'mcp_command': {'items': {'type': 'string'}, 'type': 'array'},
                                             'name': {'type': 'string'},
                                             'schema': {'const': 'forge/ForgeDescriptor/v1'},
                                             'version': {'pattern': '^\\d+\\.\\d+\\.\\d+([-.][0-9A-Za-z.-]+)?$',
                                                         'type': 'string'},
                                             'workspace': {'type': 'string'}},
                              'required': ['forge_id'],
                              'title': 'ForgeDescriptor',
                              'type': 'object'},
 'forge/ForgeEnvironmentSchema/v1': {'$id': 'forge/ForgeEnvironmentSchema/v1',
                                     '$schema': 'http://json-schema.org/draft-07/schema#',
                                     'additionalProperties': True,
                                     'properties': {'forge_id': {'pattern': '^[a-z][a-z0-9-]{0,62}[a-z0-9]$',
                                                                 'type': 'string'},
                                                    'prefix': {'pattern': '^[A-Z][A-Z0-9_]+$',
                                                               'type': 'string'},
                                                    'schema': {'const': 'forge/ForgeEnvironmentSchema/v1'},
                                                    'scope': {'enum': ['project', 'workspace', 'user']},
                                                    'state': {'enum': ['READY',
                                                                       'PARTIAL',
                                                                       'MISSING',
                                                                       'INVALID']},
                                                    'variables': {'items': {'additionalProperties': True,
                                                                            'properties': {'kind': {'enum': ['directory',
                                                                                                             'file',
                                                                                                             'string']},
                                                                                           'name': {'pattern': '^[A-Z][A-Z0-9_]+$',
                                                                                                    'type': 'string'},
                                                                                           'path': {'type': ['string',
                                                                                                             'null']},
                                                                                           'present': {'type': 'boolean'},
                                                                                           'required': {'type': 'boolean'},
                                                                                           'valid': {'type': ['boolean',
                                                                                                              'null']}},
                                                                            'required': ['name',
                                                                                         'required',
                                                                                         'kind'],
                                                                            'type': 'object'},
                                                                  'type': 'array'},
                                                    'windows_aliases': {'type': 'boolean'}},
                                     'required': ['forge_id', 'prefix', 'state', 'variables'],
                                     'title': 'ForgeEnvironmentSchema',
                                     'type': 'object'},
 'forge/ForgeHealthReport/v1': {'$id': 'forge/ForgeHealthReport/v1',
                                '$schema': 'http://json-schema.org/draft-07/schema#',
                                'additionalProperties': True,
                                'properties': {'checked_at': {'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
                                                              'type': 'string'},
                                               'checks': {'items': {'additionalProperties': True,
                                                                    'properties': {'corrective_action': {'type': ['string',
                                                                                                                  'null']},
                                                                                   'diagnosis': {'type': ['string',
                                                                                                          'null']},
                                                                                   'domain': {'enum': ['system',
                                                                                                       'install',
                                                                                                       'environment',
                                                                                                       'hosts',
                                                                                                       'operations']},
                                                                                   'evidence': {'type': ['string',
                                                                                                         'null']},
                                                                                   'id': {'type': 'string'},
                                                                                   'result': {'enum': ['pass',
                                                                                                       'warn',
                                                                                                       'fail',
                                                                                                       'skipped',
                                                                                                       'unverified']},
                                                                                   'reversibility': {'enum': ['reversible',
                                                                                                              'partial',
                                                                                                              'manual_only',
                                                                                                              'unsupported',
                                                                                                              None]},
                                                                                   'severity': {'enum': ['info',
                                                                                                         'warning',
                                                                                                         'error']}},
                                                                    'required': ['id',
                                                                                 'domain',
                                                                                 'result',
                                                                                 'severity'],
                                                                    'type': 'object'},
                                                          'type': 'array'},
                                               'forge_id': {'pattern': '^[a-z][a-z0-9-]{0,62}[a-z0-9]$',
                                                            'type': 'string'},
                                               'profile': {'type': ['string', 'null']},
                                               'schema': {'const': 'forge/ForgeHealthReport/v1'},
                                               'score': {'additionalProperties': False,
                                                         'properties': {'basis': {'type': 'string'},
                                                                        'partial': {'type': 'boolean'},
                                                                        'value': {'type': 'number'}},
                                                         'required': ['value', 'basis'],
                                                         'type': ['object', 'null']},
                                               'state': {'enum': ['NOT_INSTALLED',
                                                                  'INSTALLED',
                                                                  'CONFIGURED',
                                                                  'ACTIVE',
                                                                  'VERIFIED',
                                                                  'DEGRADED',
                                                                  'BLOCKED',
                                                                  'FAILED']},
                                               'workspace': {'type': ['string', 'null']}},
                                'required': ['forge_id', 'checked_at', 'state', 'checks'],
                                'title': 'ForgeHealthReport',
                                'type': 'object'},
 'forge/ForgeHostDescriptor/v1': {'$id': 'forge/ForgeHostDescriptor/v1',
                                  '$schema': 'http://json-schema.org/draft-07/schema#',
                                  'additionalProperties': True,
                                  'properties': {'capabilities': {'items': {'type': 'string'},
                                                                  'type': 'array'},
                                                 'command_hint': {'type': ['string', 'null']},
                                                 'detail': {'type': ['string', 'null']},
                                                 'detected': {'type': 'boolean'},
                                                 'host': {'pattern': '^[a-z][a-z0-9-]{0,31}$',
                                                          'type': 'string'},
                                                 'integration': {'enum': ['NOT_DETECTED',
                                                                          'DETECTED',
                                                                          'INSTALLED',
                                                                          'CONFIGURED',
                                                                          'MCP_REGISTERED',
                                                                          'HANDSHAKE_VERIFIED',
                                                                          'TOOLS_DISCOVERED',
                                                                          'EXECUTION_VERIFIED',
                                                                          'FAILED',
                                                                          'BLOCKED']},
                                                 'launchable': {'type': 'boolean'},
                                                 'logged_in': {'type': ['boolean', 'null']},
                                                 'schema': {'const': 'forge/ForgeHostDescriptor/v1'},
                                                 'supported': {'type': ['boolean', 'null']},
                                                 'version': {'type': ['string', 'null']}},
                                  'required': ['host', 'detected', 'launchable'],
                                  'title': 'ForgeHostDescriptor',
                                  'type': 'object'},
 'forge/ForgeInstallContract/v1': {'$id': 'forge/ForgeInstallContract/v1',
                                   '$schema': 'http://json-schema.org/draft-07/schema#',
                                   'additionalProperties': True,
                                   'properties': {'approve_flag': {'type': ['string', 'null']},
                                                  'commands': {'additionalProperties': False,
                                                               'properties': {'install': {'items': {'type': 'string'},
                                                                                          'type': 'array'},
                                                                              'uninstall': {'items': {'type': 'string'},
                                                                                            'type': ['array',
                                                                                                     'null']},
                                                                              'update': {'items': {'type': 'string'},
                                                                                         'type': ['array',
                                                                                                  'null']},
                                                                              'verify': {'items': {'type': 'string'},
                                                                                         'type': ['array',
                                                                                                  'null']}},
                                                               'required': ['install'],
                                                               'type': 'object'},
                                                  'dry_run_flag': {'type': ['string', 'null']},
                                                  'flags': {'additionalProperties': False,
                                                            'properties': {'components': {'items': {'type': 'string'},
                                                                                          'type': 'array'},
                                                                           'gateway_profile': {'items': {'type': 'string'},
                                                                                               'type': 'array'},
                                                                           'host': {'items': {'type': 'string'},
                                                                                    'type': 'array'},
                                                                           'profile': {'items': {'type': 'string'},
                                                                                       'type': 'array'},
                                                                           'scope': {'items': {'type': 'string'},
                                                                                     'type': 'array'}},
                                                            'type': 'object'},
                                                  'forge_id': {'pattern': '^[a-z][a-z0-9-]{0,62}[a-z0-9]$',
                                                               'type': 'string'},
                                                  'hosts': {'items': {'type': 'string'}, 'type': 'array'},
                                                  'schema': {'const': 'forge/ForgeInstallContract/v1'},
                                                  'scopes': {'items': {'enum': ['project',
                                                                                'workspace',
                                                                                'user']},
                                                             'type': 'array'}},
                                   'required': ['forge_id', 'commands'],
                                   'title': 'ForgeInstallContract',
                                   'type': 'object'},
 'forge/ForgeOperationPlan/v1': {'$id': 'forge/ForgeOperationPlan/v1',
                                 '$schema': 'http://json-schema.org/draft-07/schema#',
                                 'additionalProperties': True,
                                 'properties': {'created_at': {'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
                                                               'type': 'string'},
                                                'expires_at': {'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
                                                               'type': ['string', 'null']},
                                                'forges': {'items': {'additionalProperties': True,
                                                                     'properties': {'actions': {'items': {'additionalProperties': True,
                                                                                                          'properties': {'argv': {'items': {'type': 'string'},
                                                                                                                                  'type': 'array'},
                                                                                                                         'kind': {'enum': ['clone',
                                                                                                                                           'env',
                                                                                                                                           'config',
                                                                                                                                           'prereq',
                                                                                                                                           'script',
                                                                                                                                           'npm',
                                                                                                                                           'verify',
                                                                                                                                           'native',
                                                                                                                                           'binary',
                                                                                                                                           'skills',
                                                                                                                                           'agents',
                                                                                                                                           'mcp',
                                                                                                                                           'host_integration']},
                                                                                                                         'label': {'type': 'string'},
                                                                                                                         'paths': {'items': {'type': 'string'},
                                                                                                                                   'type': 'array'},
                                                                                                                         'precondition': {'type': ['string',
                                                                                                                                                   'null']},
                                                                                                                         'reversible': {'type': 'boolean'}},
                                                                                                          'required': ['kind',
                                                                                                                       'label'],
                                                                                                          'type': 'object'},
                                                                                                'type': 'array'},
                                                                                    'forge_id': {'type': 'string'},
                                                                                    'repo': {'type': 'string'},
                                                                                    'target_dir': {'type': ['string',
                                                                                                            'null']}},
                                                                     'required': ['forge_id', 'actions'],
                                                                     'type': 'object'},
                                                           'type': 'array'},
                                                'hash': {'pattern': '^[0-9a-f]{64}$', 'type': 'string'},
                                                'native': {'additionalProperties': True,
                                                           'properties': {'approve': {'type': 'boolean'},
                                                                          'components': {'items': {'type': 'string'},
                                                                                         'type': 'array'},
                                                                          'gateway_profile': {'type': 'string'},
                                                                          'host': {'type': 'string'},
                                                                          'profile': {'type': 'string'},
                                                                          'scope': {'type': 'string'}},
                                                           'type': ['object', 'null']},
                                                'plan_id': {'minLength': 8, 'type': 'string'},
                                                'schema': {'const': 'forge/ForgeOperationPlan/v1'},
                                                'source': {'enum': ['cli', 'portal', 'other']}},
                                 'required': ['plan_id', 'created_at', 'forges', 'hash'],
                                 'title': 'ForgeOperationPlan',
                                 'type': 'object'},
 'forge/ForgeOperationReceipt/v1': {'$id': 'forge/ForgeOperationReceipt/v1',
                                    '$schema': 'http://json-schema.org/draft-07/schema#',
                                    'additionalProperties': True,
                                    'properties': {'correlation_id': {'type': 'string'},
                                                   'finished_at': {'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
                                                                   'type': ['string', 'null']},
                                                   'plan_hash': {'pattern': '^[0-9a-f]{64}$',
                                                                 'type': ['string', 'null']},
                                                   'receipt_id': {'minLength': 8, 'type': 'string'},
                                                   'results': {'items': {'additionalProperties': True,
                                                                         'properties': {'detail': {'type': 'string'},
                                                                                        'elapsed_ms': {'type': ['number',
                                                                                                                'null']},
                                                                                        'evidence': {'items': {'additionalProperties': True,
                                                                                                               'properties': {'kind': {'type': 'string'},
                                                                                                                              'ref': {'type': 'string'}},
                                                                                                               'required': ['kind',
                                                                                                                            'ref'],
                                                                                                               'type': 'object'},
                                                                                                     'type': 'array'},
                                                                                        'forge_id': {'type': 'string'},
                                                                                        'head': {'type': ['string',
                                                                                                          'null']},
                                                                                        'phase': {'type': ['string',
                                                                                                           'null']},
                                                                                        'status': {'enum': ['ok',
                                                                                                            'warning',
                                                                                                            'error',
                                                                                                            'skipped']}},
                                                                         'required': ['forge_id',
                                                                                      'status',
                                                                                      'detail'],
                                                                         'type': 'object'},
                                                               'type': 'array'},
                                                   'schema': {'const': 'forge/ForgeOperationReceipt/v1'},
                                                   'started_at': {'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
                                                                  'type': 'string'},
                                                   'summary': {'additionalProperties': True,
                                                               'properties': {'errors': {'type': 'number'},
                                                                              'ok': {'type': 'number'},
                                                                              'skipped': {'type': 'number'},
                                                                              'warnings': {'type': 'number'}},
                                                               'required': ['ok', 'warnings', 'errors'],
                                                               'type': 'object'}},
                                    'required': ['receipt_id',
                                                 'correlation_id',
                                                 'started_at',
                                                 'finished_at',
                                                 'results',
                                                 'summary'],
                                    'title': 'ForgeOperationReceipt',
                                    'type': 'object'}}


def _embed() -> None:
    import sys
    from pathlib import Path

    src = Path(sys.argv[2] if len(sys.argv) > 2 else "contracts/schemas")
    out = {}
    for p in sorted(src.glob("*.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        out[doc["$id"]] = doc
    import pprint

    pprint.pprint(out, width=110, sort_dicts=True)


def _selftest() -> int:
    good = {
        "forge/ForgeDescriptor/v1": {"forge_id": "the-forge", "cli": "theforge"},
        "forge/ForgeCapability/v1": {"id": "install", "state": "supported"},
        "forge/ForgeInstallContract/v1": {
            "forge_id": "the-forge",
            "commands": {"install": ["theforge", "install", "apply"]},
        },
        "forge/ForgeEnvironmentSchema/v1": {
            "forge_id": "the-forge",
            "prefix": "THE_FORGE",
            "state": "READY",
            "variables": [{"name": "THE_FORGE_HOME", "required": True, "kind": "directory"}],
        },
        "forge/ForgeHostDescriptor/v1": {"host": "claude", "detected": True, "launchable": True},
        "forge/ForgeOperationPlan/v1": {
            "plan_id": "plan-0001",
            "created_at": "2026-10-14T00:00:00Z",
            "forges": [{"forge_id": "the-forge", "actions": [{"kind": "clone", "label": "clone"}]}],
            "hash": "0" * 64,
        },
        "forge/ForgeOperationReceipt/v1": {
            "receipt_id": "rcpt-0001",
            "correlation_id": "c1",
            "started_at": "2026-10-14T00:00:00Z",
            "finished_at": "2026-10-14T00:01:00Z",
            "results": [{"forge_id": "the-forge", "status": "ok", "detail": "done"}],
            "summary": {"ok": 1, "warnings": 0, "errors": 0},
        },
        "forge/ForgeHealthReport/v1": {
            "forge_id": "the-forge",
            "checked_at": "2026-10-14T00:00:00Z",
            "state": "VERIFIED",
            "checks": [{"id": "python", "domain": "system", "result": "pass", "severity": "info"}],
        },
    }
    bad = {
        "forge/ForgeDescriptor/v1": {},
        "forge/ForgeCapability/v1": {"id": "x", "state": "integrated"},
        "forge/ForgeHealthReport/v1": {
            "forge_id": "x",
            "checked_at": "2026-10-14T00:00:00Z",
            "state": "VERIFIED",
            "checks": [{"id": "a", "domain": "nope", "result": "pass", "severity": "info"}],
        },
    }
    fails = 0
    for cid, doc in good.items():
        errs = validate(cid, doc)
        if errs:
            print(f"FAIL {cid}: expected valid, got {[e.body() for e in errs]}")
            fails += 1
    for cid, doc in bad.items():
        errs = validate(cid, doc)
        if not errs:
            print(f"FAIL {cid}: expected errors, got none")
            fails += 1
    # version mismatch is a hard error
    errs = validate("forge/ForgeDescriptor/v1", {"schema": "forge/ForgeDescriptor/v2", "forge_id": "x"})
    if not errs or errs[0].code != "CONTRACT-VERSION":
        print("FAIL version-mismatch handling")
        fails += 1
    print(f"selftest: {'OK' if fails == 0 else f'{fails} failures'}")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys

    if "--embed" in sys.argv:
        _embed()
    elif "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    else:
        print("usage: forge_contracts.py --selftest | --embed <schemas-dir>")
