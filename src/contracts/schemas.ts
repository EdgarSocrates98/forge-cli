// Canonical forge/<Name>/v1 schemas, embedded for bundling.
// Source of truth: contracts/schemas/*.json — parity enforced by
// tests/contracts.test.ts (reads the canonical files and deep-compares).

export const SCHEMAS: Record<string, Record<string, unknown>> = {
  'forge/ForgeDescriptor/v1': {
    $id: 'forge/ForgeDescriptor/v1',
    type: 'object',
    required: ['forge_id'],
    properties: {
      schema: { const: 'forge/ForgeDescriptor/v1' },
      forge_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}[a-z0-9]$' },
      name: { type: 'string' },
      version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+([-.][0-9A-Za-z.-]+)?$' },
      kind: { enum: ['python', 'node', 'other'] },
      cli: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_-]+$' },
      mcp_command: { type: 'array', items: { type: 'string' } },
      install: { $ref: 'forge/ForgeInstallContract/v1' },
      env_schema: { $ref: 'forge/ForgeEnvironmentSchema/v1' },
      capabilities: { type: 'array', items: { $ref: 'forge/ForgeCapability/v1' } },
      workspace: { type: 'string' },
    },
    additionalProperties: true,
  },
  'forge/ForgeCapability/v1': {
    $id: 'forge/ForgeCapability/v1',
    type: 'object',
    required: ['id', 'state'],
    properties: {
      schema: { const: 'forge/ForgeCapability/v1' },
      id: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$' },
      state: { enum: ['supported', 'unverified', 'unsupported', 'not_applicable'] },
      label_key: { type: 'string' },
      detail: { type: ['string', 'null'] },
      evidence: { type: ['string', 'null'] },
      since: { type: ['string', 'null'] },
      requires: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  },
  'forge/ForgeInstallContract/v1': {
    $id: 'forge/ForgeInstallContract/v1',
    type: 'object',
    required: ['forge_id', 'commands'],
    properties: {
      schema: { const: 'forge/ForgeInstallContract/v1' },
      forge_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}[a-z0-9]$' },
      commands: {
        type: 'object',
        required: ['install'],
        properties: {
          install: { type: 'array', items: { type: 'string' } },
          update: { type: ['array', 'null'], items: { type: 'string' } },
          uninstall: { type: ['array', 'null'], items: { type: 'string' } },
          verify: { type: ['array', 'null'], items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      flags: {
        type: 'object',
        properties: {
          scope: { type: 'array', items: { type: 'string' } },
          profile: { type: 'array', items: { type: 'string' } },
          components: { type: 'array', items: { type: 'string' } },
          host: { type: 'array', items: { type: 'string' } },
          gateway_profile: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      dry_run_flag: { type: ['string', 'null'] },
      approve_flag: { type: ['string', 'null'] },
      scopes: { type: 'array', items: { enum: ['project', 'workspace', 'user'] } },
      hosts: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  },
  'forge/ForgeEnvironmentSchema/v1': {
    $id: 'forge/ForgeEnvironmentSchema/v1',
    type: 'object',
    required: ['forge_id', 'prefix', 'state', 'variables'],
    properties: {
      schema: { const: 'forge/ForgeEnvironmentSchema/v1' },
      forge_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}[a-z0-9]$' },
      prefix: { type: 'string', pattern: '^[A-Z][A-Z0-9_]+$' },
      scope: { enum: ['project', 'workspace', 'user'] },
      state: { enum: ['READY', 'PARTIAL', 'MISSING', 'INVALID'] },
      variables: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'required', 'kind'],
          properties: {
            name: { type: 'string', pattern: '^[A-Z][A-Z0-9_]+$' },
            required: { type: 'boolean' },
            kind: { enum: ['directory', 'file', 'string'] },
            present: { type: 'boolean' },
            valid: { type: ['boolean', 'null'] },
            path: { type: ['string', 'null'] },
          },
          additionalProperties: true,
        },
      },
      windows_aliases: { type: 'boolean' },
    },
    additionalProperties: true,
  },
  'forge/ForgeHostDescriptor/v1': {
    $id: 'forge/ForgeHostDescriptor/v1',
    type: 'object',
    required: ['host', 'detected', 'launchable'],
    properties: {
      schema: { const: 'forge/ForgeHostDescriptor/v1' },
      host: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
      detected: { type: 'boolean' },
      version: { type: ['string', 'null'] },
      supported: { type: ['boolean', 'null'] },
      logged_in: { type: ['boolean', 'null'] },
      integration: {
        enum: [
          'NOT_DETECTED',
          'DETECTED',
          'INSTALLED',
          'CONFIGURED',
          'MCP_REGISTERED',
          'HANDSHAKE_VERIFIED',
          'TOOLS_DISCOVERED',
          'EXECUTION_VERIFIED',
          'FAILED',
          'BLOCKED',
        ],
      },
      launchable: { type: 'boolean' },
      capabilities: { type: 'array', items: { type: 'string' } },
      command_hint: { type: ['string', 'null'] },
      detail: { type: ['string', 'null'] },
    },
    additionalProperties: true,
  },
  'forge/ForgeOperationPlan/v1': {
    $id: 'forge/ForgeOperationPlan/v1',
    type: 'object',
    required: ['plan_id', 'created_at', 'forges', 'hash'],
    properties: {
      schema: { const: 'forge/ForgeOperationPlan/v1' },
      plan_id: { type: 'string', minLength: 8 },
      created_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}' },
      expires_at: {
        type: ['string', 'null'],
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
      },
      source: { enum: ['cli', 'portal', 'other'] },
      forges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['forge_id', 'actions'],
          properties: {
            forge_id: { type: 'string' },
            repo: { type: 'string' },
            target_dir: { type: ['string', 'null'] },
            actions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kind', 'label'],
                properties: {
                  kind: {
                    enum: [
                      'clone',
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
                      'host_integration',
                    ],
                  },
                  label: { type: 'string' },
                  argv: { type: 'array', items: { type: 'string' } },
                  paths: { type: 'array', items: { type: 'string' } },
                  reversible: { type: 'boolean' },
                  precondition: { type: ['string', 'null'] },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      native: {
        type: ['object', 'null'],
        properties: {
          scope: { type: 'string' },
          profile: { type: 'string' },
          components: { type: 'array', items: { type: 'string' } },
          host: { type: 'string' },
          gateway_profile: { type: 'string' },
          approve: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
    additionalProperties: true,
  },
  'forge/ForgeOperationReceipt/v1': {
    $id: 'forge/ForgeOperationReceipt/v1',
    type: 'object',
    required: ['receipt_id', 'correlation_id', 'started_at', 'finished_at', 'results', 'summary'],
    properties: {
      schema: { const: 'forge/ForgeOperationReceipt/v1' },
      receipt_id: { type: 'string', minLength: 8 },
      plan_hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
      correlation_id: { type: 'string' },
      started_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}' },
      finished_at: {
        type: ['string', 'null'],
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
      },
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['forge_id', 'status', 'detail'],
          properties: {
            forge_id: { type: 'string' },
            status: { enum: ['ok', 'warning', 'error', 'skipped'] },
            phase: { type: ['string', 'null'] },
            detail: { type: 'string' },
            head: { type: ['string', 'null'] },
            elapsed_ms: { type: ['number', 'null'] },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kind', 'ref'],
                properties: { kind: { type: 'string' }, ref: { type: 'string' } },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      summary: {
        type: 'object',
        required: ['ok', 'warnings', 'errors'],
        properties: {
          ok: { type: 'number' },
          warnings: { type: 'number' },
          errors: { type: 'number' },
          skipped: { type: 'number' },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  'forge/ForgeHealthReport/v1': {
    $id: 'forge/ForgeHealthReport/v1',
    type: 'object',
    required: ['forge_id', 'checked_at', 'state', 'checks'],
    properties: {
      schema: { const: 'forge/ForgeHealthReport/v1' },
      forge_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,62}[a-z0-9]$' },
      checked_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}' },
      state: {
        enum: [
          'NOT_INSTALLED',
          'INSTALLED',
          'CONFIGURED',
          'ACTIVE',
          'VERIFIED',
          'DEGRADED',
          'BLOCKED',
          'FAILED',
        ],
      },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'domain', 'result', 'severity'],
          properties: {
            id: { type: 'string' },
            domain: { enum: ['system', 'install', 'environment', 'hosts', 'operations'] },
            result: { enum: ['pass', 'warn', 'fail', 'skipped', 'unverified'] },
            severity: { enum: ['info', 'warning', 'error'] },
            diagnosis: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'] },
            corrective_action: { type: ['string', 'null'] },
            reversibility: { enum: ['reversible', 'partial', 'manual_only', 'unsupported', null] },
          },
          additionalProperties: true,
        },
      },
      score: {
        type: ['object', 'null'],
        required: ['value', 'basis'],
        properties: {
          value: { type: 'number' },
          basis: { type: 'string' },
          partial: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      workspace: { type: ['string', 'null'] },
      profile: { type: ['string', 'null'] },
    },
    additionalProperties: true,
  },
  'forge/LocalForgeSourceDetection/v1': {
    $id: 'forge/LocalForgeSourceDetection/v1',
    type: 'object',
    required: [
      'schema',
      'path',
      'state',
      'is_git',
      'manifest_valid',
      'identity',
      'source_trust',
      'integrity',
      'structure',
      'reasons',
    ],
    properties: {
      schema: { const: 'forge/LocalForgeSourceDetection/v1' },
      path: { type: 'string', minLength: 1 },
      state: {
        enum: [
          'GIT_REPOSITORY',
          'GIT_WORKTREE',
          'GITLESS_VALID_FORGE',
          'GITLESS_PARTIAL_FORGE',
          'UNKNOWN_DIRECTORY',
          'CONFLICTING_IDENTITY',
          'INVALID_MANIFEST',
          'UNTRUSTED_SOURCE',
        ],
      },
      is_git: { type: 'boolean' },
      manifest_valid: { type: 'boolean' },
      forge_id: { type: 'string' },
      identity: { enum: ['A', 'B', 'C', 'none'] },
      source_trust: { enum: ['A', 'B', 'C', 'none'] },
      integrity: { enum: ['verified', 'partial', 'unverified'] },
      structure: {
        type: 'object',
        required: ['setup_scripts', 'project_markers'],
        properties: {
          setup_scripts: { type: 'array', items: { type: 'string' } },
          project_markers: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
      reasons: { type: 'array', items: { type: 'string' } },
      refusal: {
        type: 'object',
        required: ['code', 'cause', 'remedy'],
        properties: {
          code: {
            enum: [
              'FORGE-SOURCE-NOT-FOUND',
              'FORGE-SOURCE-GITLESS',
              'FORGE-SOURCE-INVALID',
              'FORGE-SOURCE-CONFLICT',
              'FORGE-INSTALL-VERIFICATION-FAILED',
            ],
          },
          cause: { type: 'string', minLength: 1 },
          remedy: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  'forge/EnvironmentDiscovery/v1': {
    $id: 'forge/EnvironmentDiscovery/v1',
    type: 'object',
    required: [
      'schema',
      'generated_at',
      'status',
      'os',
      'shells',
      'route',
      'python',
      'git',
      'network',
      'disk',
      'permissions',
      'write_targets',
      'forges_detected',
      'blockers',
      'warnings',
      'recommendations',
    ],
    properties: {
      schema: {
        const: 'forge/EnvironmentDiscovery/v1',
      },
      generated_at: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
      },
      status: {
        enum: ['ok', 'warnings', 'blocked'],
      },
      os: {
        type: 'object',
        required: ['platform', 'arch', 'release'],
        properties: {
          platform: {
            type: 'string',
            minLength: 1,
          },
          arch: {
            type: 'string',
            minLength: 1,
          },
          release: {
            type: 'string',
          },
        },
        additionalProperties: true,
      },
      shells: {
        type: 'object',
        required: ['powershell', 'pwsh', 'bash', 'git_bash', 'wsl', 'cygwin', 'msys2'],
        properties: {
          powershell: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          pwsh: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          bash: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          git_bash: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          wsl: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          cygwin: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          msys2: {
            type: 'object',
            required: ['present', 'probes'],
            properties: {
              present: {
                type: 'boolean',
              },
              version: {
                type: ['string', 'null'],
              },
              executable: {
                type: ['string', 'null'],
              },
              kind: {
                type: ['string', 'null'],
              },
              probes: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  required: ['command', 'ok'],
                  properties: {
                    command: {
                      type: 'string',
                      minLength: 1,
                    },
                    ok: {
                      type: 'boolean',
                    },
                    output: {
                      type: ['string', 'null'],
                    },
                    timed_out: {
                      type: 'boolean',
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      route: {
        type: 'object',
        required: ['platform', 'selected', 'script_chain'],
        properties: {
          platform: {
            type: 'string',
            minLength: 1,
          },
          selected: {
            enum: ['powershell', 'pwsh', 'git_bash', 'sh', 'none'],
          },
          shell: {
            type: ['string', 'null'],
          },
          script_chain: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          refusal: {
            type: 'object',
            required: ['code', 'cause', 'remedy'],
            properties: {
              code: {
                enum: [
                  'FORGE-SOURCE-NOT-FOUND',
                  'FORGE-SOURCE-GITLESS',
                  'FORGE-SOURCE-INVALID',
                  'FORGE-SOURCE-CONFLICT',
                  'FORGE-INSTALL-VERIFICATION-FAILED',
                  'FORGE-SHELL-NOT-FOUND',
                  'FORGE-SHELL-UNAVAILABLE',
                  'FORGE-INSTALL-PERMISSION-DENIED',
                  'FORGE-ENV-PERSISTENCE-FAILED',
                ],
              },
              cause: {
                type: 'string',
                minLength: 1,
              },
              remedy: {
                type: 'string',
                minLength: 1,
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      python: {
        type: 'object',
        required: ['present', 'source', 'pipeline'],
        properties: {
          present: {
            type: 'boolean',
          },
          exe: {
            type: ['string', 'null'],
          },
          args: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          version: {
            type: ['string', 'null'],
          },
          toolchain: {
            type: ['string', 'null'],
          },
          source: {
            const: 'pythonCandidates',
          },
          pipeline: {
            type: 'string',
            minLength: 1,
          },
        },
        additionalProperties: true,
      },
      git: {
        type: 'object',
        required: ['present'],
        properties: {
          present: {
            type: 'boolean',
          },
          version: {
            type: ['string', 'null'],
          },
          executable: {
            type: ['string', 'null'],
          },
        },
        additionalProperties: true,
      },
      network: {
        type: 'object',
        required: ['status', 'probed'],
        properties: {
          status: {
            enum: ['off', 'unknown'],
          },
          probed: {
            type: 'boolean',
          },
          detail: {
            type: 'string',
          },
        },
        additionalProperties: true,
      },
      disk: {
        type: 'object',
        required: ['candidates'],
        properties: {
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'writable'],
              properties: {
                path: {
                  type: 'string',
                  minLength: 1,
                },
                writable: {
                  type: ['boolean', 'null'],
                },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
      permissions: {
        type: 'object',
        required: ['home_writable', 'tmpdir_writable', 'denied'],
        properties: {
          home_writable: {
            type: ['boolean', 'null'],
          },
          tmpdir_writable: {
            type: ['boolean', 'null'],
          },
          denied: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        additionalProperties: true,
      },
      write_targets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'path', 'source', 'exists', 'writable'],
          properties: {
            name: {
              enum: ['home', 'bin', 'venvs', 'receipts', 'workspace_state', 'env_files'],
            },
            path: {
              type: 'string',
              minLength: 1,
            },
            source: {
              enum: ['explicit', 'env', 'user', 'system'],
            },
            env_var: {
              type: ['string', 'null'],
            },
            exists: {
              type: 'boolean',
            },
            writable: {
              type: ['boolean', 'null'],
            },
            checked: {
              type: ['string', 'null'],
            },
            fallback: {
              type: ['string', 'null'],
            },
            denied: {
              type: ['object', 'null'],
              required: ['code', 'cause', 'remedy'],
              properties: {
                code: {
                  enum: [
                    'FORGE-SOURCE-NOT-FOUND',
                    'FORGE-SOURCE-GITLESS',
                    'FORGE-SOURCE-INVALID',
                    'FORGE-SOURCE-CONFLICT',
                    'FORGE-INSTALL-VERIFICATION-FAILED',
                    'FORGE-SHELL-NOT-FOUND',
                    'FORGE-SHELL-UNAVAILABLE',
                    'FORGE-INSTALL-PERMISSION-DENIED',
                    'FORGE-ENV-PERSISTENCE-FAILED',
                  ],
                },
                cause: {
                  type: 'string',
                  minLength: 1,
                },
                remedy: {
                  type: 'string',
                  minLength: 1,
                },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
      },
      forges_detected: {
        type: 'object',
        required: ['count', 'names', 'by_method'],
        properties: {
          count: {
            type: 'number',
            min: 0,
          },
          names: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          by_method: {
            type: 'object',
            required: ['local', 'pypi', 'unknown'],
            properties: {
              local: {
                type: 'number',
                min: 0,
              },
              pypi: {
                type: 'number',
                min: 0,
              },
              unknown: {
                type: 'number',
                min: 0,
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'message'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
            },
            code: {
              enum: [
                'FORGE-SOURCE-NOT-FOUND',
                'FORGE-SOURCE-GITLESS',
                'FORGE-SOURCE-INVALID',
                'FORGE-SOURCE-CONFLICT',
                'FORGE-INSTALL-VERIFICATION-FAILED',
                'FORGE-SHELL-NOT-FOUND',
                'FORGE-SHELL-UNAVAILABLE',
                'FORGE-INSTALL-PERMISSION-DENIED',
                'FORGE-ENV-PERSISTENCE-FAILED',
              ],
            },
            message: {
              type: 'string',
              minLength: 1,
            },
            remedy: {
              type: ['string', 'null'],
            },
          },
          additionalProperties: true,
        },
      },
      warnings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'message'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
            },
            code: {
              enum: [
                'FORGE-SOURCE-NOT-FOUND',
                'FORGE-SOURCE-GITLESS',
                'FORGE-SOURCE-INVALID',
                'FORGE-SOURCE-CONFLICT',
                'FORGE-INSTALL-VERIFICATION-FAILED',
                'FORGE-SHELL-NOT-FOUND',
                'FORGE-SHELL-UNAVAILABLE',
                'FORGE-INSTALL-PERMISSION-DENIED',
                'FORGE-ENV-PERSISTENCE-FAILED',
              ],
            },
            message: {
              type: 'string',
              minLength: 1,
            },
            remedy: {
              type: ['string', 'null'],
            },
          },
          additionalProperties: true,
        },
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'message'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
            },
            code: {
              enum: [
                'FORGE-SOURCE-NOT-FOUND',
                'FORGE-SOURCE-GITLESS',
                'FORGE-SOURCE-INVALID',
                'FORGE-SOURCE-CONFLICT',
                'FORGE-INSTALL-VERIFICATION-FAILED',
                'FORGE-SHELL-NOT-FOUND',
                'FORGE-SHELL-UNAVAILABLE',
                'FORGE-INSTALL-PERMISSION-DENIED',
                'FORGE-ENV-PERSISTENCE-FAILED',
              ],
            },
            message: {
              type: 'string',
              minLength: 1,
            },
            remedy: {
              type: ['string', 'null'],
            },
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: true,
  },
} as const;

export const CONTRACT_IDS = Object.keys(SCHEMAS);
