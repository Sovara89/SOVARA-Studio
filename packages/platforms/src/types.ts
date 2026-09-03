export type PlatformId = 'youtube' | 'vk';
export interface PlatformAdapter {
  readonly id: PlatformId;
}
export type ProviderImplementationStatus = 'NOT_IMPLEMENTED';
