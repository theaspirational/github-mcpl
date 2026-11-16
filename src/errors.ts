/**
 * MCPL SPEC §6.6: a method that will never be answered must return an error,
 * and a host's rejection is a JSON-RPC error object with the documented code,
 * not a result carrying a failure flag. These errors take that shape.
 */

import { ERR_CAPABILITY_DENIED } from '@animalabs/mcpl-core';

export class McplRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McplRpcError';
  }
}

export function capabilityDenied(capability: string): McplRpcError {
  return new McplRpcError(ERR_CAPABILITY_DENIED, `Capability denied: ${capability}`, { capability });
}
