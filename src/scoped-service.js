// Adapted from Ri0n72Y/dsh-workspace-scope, src/host/scoped-service.ts.
// Commit 71db3f5ceb166b88f259f89e610ac6c88b1e5d78, MIT; see THIRD_PARTY_NOTICES.md.
// Change: use the supplied registration context, which can be a managed child fiber.
export function scopedService(ctx, name) {
  const service = ctx.get(name)
  if (service === undefined) throw new Error(`Required scoped service is unavailable: ${name}`)
  return service
}
