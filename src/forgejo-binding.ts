import type { IntegrationBinding } from "@todu/core";

export const FORGEJO_PROVIDER_NAME = "forgejo";
export const FORGEJO_REPOSITORY_TARGET_KIND = "repository";

export type ForgejoBindingValidationErrorCode =
  | "INVALID_PROVIDER"
  | "INVALID_TARGET_KIND"
  | "INVALID_TARGET_REF";

export interface ForgejoRepositoryTarget {
  owner: string;
  repo: string;
}

export interface ForgejoRepositoryBinding extends ForgejoRepositoryTarget {
  binding: IntegrationBinding;
}

export class ForgejoBindingValidationError extends Error {
  readonly code: ForgejoBindingValidationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ForgejoBindingValidationErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ForgejoBindingValidationError";
    this.code = code;
    this.details = details;
  }
}

export function parseForgejoRepositoryTargetRef(targetRef: string): ForgejoRepositoryTarget {
  const normalizedTargetRef = targetRef.trim();
  if (!normalizedTargetRef) {
    throw new ForgejoBindingValidationError(
      "INVALID_TARGET_REF",
      "Invalid Forgejo repository targetRef: value is required",
      {
        targetRef,
      }
    );
  }

  const segments = normalizedTargetRef.split("/");
  if (segments.length !== 2) {
    throw new ForgejoBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid Forgejo repository targetRef \`${targetRef}\`: expected owner/repo format`,
      {
        targetRef,
      }
    );
  }

  const [owner, repo] = segments.map((segment) => segment.trim());
  if (!owner || !repo) {
    throw new ForgejoBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid Forgejo repository targetRef \`${targetRef}\`: owner and repo must both be non-empty`,
      {
        targetRef,
        owner,
        repo,
      }
    );
  }

  if (owner.includes("/") || repo.includes("/")) {
    throw new ForgejoBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid Forgejo repository targetRef \`${targetRef}\`: expected exactly one slash`,
      {
        targetRef,
      }
    );
  }

  return {
    owner,
    repo,
  };
}

export function parseForgejoBinding(binding: IntegrationBinding): ForgejoRepositoryBinding {
  if (binding.provider !== FORGEJO_PROVIDER_NAME) {
    throw new ForgejoBindingValidationError(
      "INVALID_PROVIDER",
      `Invalid Forgejo integration binding ${binding.id}: provider must be \`${FORGEJO_PROVIDER_NAME}\` (received: \`${binding.provider}\`)`,
      {
        bindingId: binding.id,
        provider: binding.provider,
      }
    );
  }

  if (binding.targetKind !== FORGEJO_REPOSITORY_TARGET_KIND) {
    throw new ForgejoBindingValidationError(
      "INVALID_TARGET_KIND",
      `Invalid Forgejo integration binding ${binding.id}: targetKind must be \`${FORGEJO_REPOSITORY_TARGET_KIND}\` (received: \`${binding.targetKind}\`)`,
      {
        bindingId: binding.id,
        targetKind: binding.targetKind,
      }
    );
  }

  const target = parseForgejoRepositoryTargetRef(binding.targetRef);

  return {
    binding,
    owner: target.owner,
    repo: target.repo,
  };
}
