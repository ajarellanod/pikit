/**
 * Where execution-remote's tests reach their sandbox hosts, shared by the test (in workerd) and the
 * outbound service that answers for them (`sandbox-outbound.ts`, in Node): names nothing else uses,
 * and the token each host is started with. Two hosts, each its own process and token: `general` (the
 * default one) and `render`.
 */

export const SANDBOX_HOST = "sandbox.pikit.test";
export const SANDBOX_TOKEN = "workerd-sandbox-token-0123456789abcdef";
export const RENDER_SANDBOX_HOST = "render.sandbox.pikit.test";
export const RENDER_SANDBOX_TOKEN = "workerd-render-sandbox-token-fedcba9876";
