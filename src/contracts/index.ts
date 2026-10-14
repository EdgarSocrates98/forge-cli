import { ContractValidator } from './validator.js';
import { SCHEMAS, CONTRACT_IDS } from './schemas.js';

export { ContractValidator } from './validator.js';
export type { ContractError } from './validator.js';
export { SCHEMAS, CONTRACT_IDS };
export { negotiateCapabilities, resolveDiscovery } from './negotiate.js';
export type {
  Capability,
  CapabilityState,
  NegotiationResult,
  NegotiationAnswer,
  NegotiationStatus,
  DiscoverySource,
  DiscoveryState,
  DiscoveryOrigin,
} from './negotiate.js';

export function contractValidator(): ContractValidator {
  return new ContractValidator(SCHEMAS);
}
