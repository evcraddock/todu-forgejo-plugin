// Kept in persisted diagnostics so retry/backoff and restart cannot turn a
// blocked identity operation into an apparently successful empty sync cycle.
export const FORGEJO_IDENTITY_ERROR_PREFIX = "Forgejo requires explicit identity repair: ";

export class ForgejoIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${FORGEJO_IDENTITY_ERROR_PREFIX}${message}`, options);
    this.name = "ForgejoIdentityError";
  }
}
