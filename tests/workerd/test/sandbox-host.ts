/**
 * Where execution-remote's tests reach their sandbox host, shared by the test (in workerd) and the
 * outbound service that answers for it (`sandbox-outbound.ts`, in Node): a name nothing else uses,
 * and the token the host is started with.
 */

export const SANDBOX_HOST = "sandbox.pikit.test";
export const SANDBOX_TOKEN = "workerd-sandbox-token-0123456789abcdef";
