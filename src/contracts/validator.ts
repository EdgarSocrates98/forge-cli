// Minimal draft-07 subset validator for forge/<Name>/v1 contracts.
// Supports: type, required, properties, additionalProperties, enum, const,
// pattern, items, $ref (internal forge/ only), minLength, maxLength, min, max.
// Never throws on data — returns structured errors.

export interface ContractError {
  code: string;
  message: string;
  path: string;
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function typeOk(value: unknown, spec: string | string[]): boolean {
  const types = Array.isArray(spec) ? spec : [spec];
  return types.some((t) => TYPE_CHECKS[t]?.(value) === true);
}

type Schema = Record<string, unknown>;

export class ContractValidator {
  constructor(private readonly schemas: Readonly<Record<string, Schema>>) {}

  validate(contractId: string, document: unknown): ContractError[] {
    const schema = this.schemas[contractId];
    if (!schema) {
      return [{ code: 'CONTRACT-UNKNOWN', message: `unknown contract: ${contractId}`, path: '' }];
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return [{ code: 'CONTRACT-TYPE', message: 'document must be a JSON object', path: '' }];
    }
    const declared = (document as Record<string, unknown>).schema;
    if (declared !== undefined && declared !== contractId) {
      return [
        {
          code: 'CONTRACT-VERSION',
          message: `document declares ${String(declared)}, expected ${contractId}`,
          path: '/schema',
        },
      ];
    }
    const errs: ContractError[] = [];
    this.check(document, schema, '', errs);
    return errs;
  }

  validateDocument(document: unknown): ContractError[] {
    const declared =
      typeof document === 'object' && document !== null
        ? (document as Record<string, unknown>).schema
        : undefined;
    if (typeof declared !== 'string' || !declared.startsWith('forge/')) {
      return [
        {
          code: 'CONTRACT-VERSION',
          message: "document must declare a 'forge/<Name>/vN' schema",
          path: '/schema',
        },
      ];
    }
    return this.validate(declared, document);
  }

  private check(value: unknown, schema: Schema, path: string, errs: ContractError[]): void {
    if (typeof schema.$ref === 'string') {
      const target = schema.$ref;
      if (!target.startsWith('forge/')) {
        errs.push({ code: 'CONTRACT-REF', message: `external ref refused: ${target}`, path });
        return;
      }
      const resolved = this.schemas[target];
      if (!resolved) {
        errs.push({ code: 'CONTRACT-UNKNOWN', message: `unknown contract: ${target}`, path });
        return;
      }
      this.check(value, resolved, path, errs);
      return;
    }

    if ('const' in schema && value !== schema.const) {
      errs.push({
        code: 'CONTRACT-CONST',
        message: `expected ${JSON.stringify(schema.const)}`,
        path,
      });
      return;
    }

    if (schema.type !== undefined && !typeOk(value, schema.type as string | string[])) {
      errs.push({
        code: 'CONTRACT-TYPE',
        message: `expected type ${JSON.stringify(schema.type)}`,
        path,
      });
      return;
    }

    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
      errs.push({
        code: 'CONTRACT-ENUM',
        message: `value not in ${JSON.stringify(schema.enum)}`,
        path,
      });
      return;
    }

    if (typeof value === 'string') {
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
        errs.push({ code: 'CONTRACT-PATTERN', message: `does not match ${schema.pattern}`, path });
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        errs.push({ code: 'CONTRACT-LENGTH', message: 'string too short', path });
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        errs.push({ code: 'CONTRACT-LENGTH', message: 'string too long', path });
      }
    }

    if (typeof value === 'number') {
      if (typeof schema.min === 'number' && value < schema.min) {
        errs.push({ code: 'CONTRACT-RANGE', message: `< ${schema.min}`, path });
      }
      if (typeof schema.max === 'number' && value > schema.max) {
        errs.push({ code: 'CONTRACT-RANGE', message: `> ${schema.max}`, path });
      }
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const req of (schema.required as string[]) ?? []) {
        if (!(req in obj)) {
          errs.push({
            code: 'CONTRACT-REQUIRED',
            message: `missing '${req}'`,
            path: `${path}/${req}`,
          });
        }
      }
      const props = (schema.properties as Record<string, Schema>) ?? {};
      const additional = schema.additionalProperties;
      for (const [key, val] of Object.entries(obj)) {
        if (key in props) {
          this.check(val, props[key], `${path}/${key}`, errs);
        } else if (additional === false) {
          errs.push({
            code: 'CONTRACT-UNKNOWN-FIELD',
            message: `unexpected '${key}'`,
            path: `${path}/${key}`,
          });
        } else if (typeof additional === 'object' && additional !== null) {
          this.check(val, additional as Schema, `${path}/${key}`, errs);
        }
      }
    }

    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        errs.push({ code: 'CONTRACT-SIZE', message: 'too few items', path });
      }
      const itemSchema = schema.items;
      if (typeof itemSchema === 'object' && itemSchema !== null) {
        value.forEach((item, i) => this.check(item, itemSchema as Schema, `${path}/${i}`, errs));
      }
    }
  }
}
