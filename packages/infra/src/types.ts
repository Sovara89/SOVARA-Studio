export interface RedisOptions {
  host: string;
  port: number;
}
export type RedisConnectionRole = 'producer' | 'worker';
export interface S3Options {
  endpoint?: string;
  presignEndpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  maxAttempts?: number;
}
export interface PostgresOptions {
  connectionString: string;
}
