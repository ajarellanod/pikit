/** The types of `bucket.mjs`, plain JavaScript so that Node runs it in a CI deploy without pikit. */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface BucketSpec {
  /** `s3`, `gs` or `az`; `s3` without a scheme. */
  scheme: string;
  name: string;
  /** Empty, or slash-terminated. */
  prefix: string;
}

/** The fleet bucket, as much as a rollback needs. */
export interface BucketStore {
  bucket: BucketSpec;
  unsupported?: undefined;
  get(key: string): Promise<{ body: string; etag: string | undefined } | undefined>;
  replace(key: string, body: string, etag: string | undefined): Promise<boolean>;
}

/** Why pikit cannot read or write the bucket. */
export interface Unsupported {
  unsupported: string;
}

export function parseBucket(spec: string): BucketSpec;
export function signRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  credentials: Credentials;
  date?: Date;
}): Record<string, string>;
export function bucketStore(env: Readonly<Record<string, string | undefined>>, fetcher?: typeof fetch): BucketStore | Unsupported;
