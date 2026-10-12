export class ForgejoHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string
  ) {
    super(`Forgejo API ${method} ${path} failed: ${status} ${body}`);
    this.name = "ForgejoHttpError";
  }
}

export function getForgejoHttpStatus(error: unknown): number | null {
  if (error instanceof ForgejoHttpError) return error.status;
  // Preserve support for injected clients and persisted pre-structured errors,
  // but never interpret resource numbers or response-body numbers as statuses.
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /^(?:authentication failed|permission denied|resource not found|rate limited|server error): /,
    ""
  );
  const match =
    message.match(/^Forgejo API(?: [A-Z]+ \S+)? failed: (\d{3})\b/) ?? message.match(/^(\d{3})\b/);
  return match ? Number(match[1]) : null;
}
