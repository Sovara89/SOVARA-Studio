import type {
  createPublishingAccountRepository,
  createPublicationRepository,
  createVideoRepository,
} from '@sovara-studio/db';
import type { MediaSource, PublicationCredentialSnapshot } from '@sovara-studio/platforms';

type PublicationRepository = ReturnType<typeof createPublicationRepository>;
type AccountRepository = ReturnType<typeof createPublishingAccountRepository>;
type VideoRepository = ReturnType<typeof createVideoRepository>;

export class PublicationPreflightError extends Error {
  constructor(
    readonly disposition: 'retryable' | 'terminal' | 'reauthorization_required',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicationPreflightError';
  }
}

export type PublicationPreflightResult = {
  credential: PublicationCredentialSnapshot;
  media: MediaSource;
};

const youtubeRequiredScopes = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
] as const;

export function createPublicationPreflight(input: {
  accounts: AccountRepository;
  videos: VideoRepository;
  credentials: {
    getAccessTokenSnapshot(
      userId: string,
      accountId: string,
      input?: { forceRefresh?: boolean; expectedCredentialRevision?: number },
    ): Promise<{
      accessToken: string;
      credentialRevision: number;
      providerAccountId: string;
      scopes: readonly string[];
    }>;
    getAccessToken(
      userId: string,
      accountId: string,
      input?: { forceRefresh?: boolean; expectedCredentialRevision?: number },
    ): Promise<string>;
  };
  createMediaSource(
    video: Awaited<ReturnType<VideoRepository['findByIdForUser']>>[number],
  ): MediaSource;
}) {
  return async (
    publication: Awaited<ReturnType<PublicationRepository['findById']>>[number],
    signal: AbortSignal,
  ): Promise<PublicationPreflightResult> => {
    if (signal.aborted)
      throw new PublicationPreflightError(
        'retryable',
        'PREFLIGHT_ABORTED',
        'Preflight was aborted',
      );
    const accountRows = await input.accounts.findByIdForUser(
      publication.userId,
      publication.publishingAccountId,
    );
    const account = accountRows[0];
    if (!account || account.platform !== publication.platform || account.status !== 'active')
      throw new PublicationPreflightError(
        account?.status === 'reauthorization_required' ? 'reauthorization_required' : 'terminal',
        'ACCOUNT_NOT_ACTIVE',
        'Publishing account is not active',
      );
    const videoRows = await input.videos.findByIdForUser(publication.userId, publication.videoId);
    const video = videoRows[0];
    if (!video || video.state !== 'ready' || video.verifiedSizeBytes === null)
      throw new PublicationPreflightError(
        'terminal',
        'VIDEO_NOT_READY',
        'Source video is not ready',
      );
    const media = input.createMediaSource(video);
    if (media.sizeBytes !== video.verifiedSizeBytes || media.contentType !== video.contentType)
      throw new PublicationPreflightError(
        'terminal',
        'MEDIA_DESCRIPTOR_MISMATCH',
        'Media source does not match the verified video',
      );
    if (signal.aborted)
      throw new PublicationPreflightError(
        'retryable',
        'PREFLIGHT_ABORTED',
        'Preflight was aborted',
      );
    const token = await input.credentials.getAccessTokenSnapshot(
      publication.userId,
      publication.publishingAccountId,
    );
    if (!token.accessToken)
      throw new PublicationPreflightError(
        'reauthorization_required',
        'NO_ACCESS_TOKEN',
        'No usable access token',
      );
    if (!token.providerAccountId)
      throw new PublicationPreflightError(
        'reauthorization_required',
        'NO_PROVIDER_ACCOUNT_ID',
        'Publishing account has no authoritative provider identity',
      );
    if (
      publication.platform === 'youtube' &&
      youtubeRequiredScopes.some((scope) => !token.scopes.includes(scope))
    )
      throw new PublicationPreflightError(
        'reauthorization_required',
        'YOUTUBE_SCOPES_INSUFFICIENT',
        'YouTube account is missing required upload or channel scopes',
      );
    if (publication.platform === 'vk' && !token.scopes.includes('video'))
      throw new PublicationPreflightError(
        'reauthorization_required',
        'VK_SCOPES_INSUFFICIENT',
        'VK account is missing the video scope',
      );
    let acceptedRevision = token.credentialRevision;
    let acceptedAccessToken = token.accessToken;
    return {
      media,
      credential: {
        accountId: account.id,
        userId: account.userId,
        platform: account.platform as 'youtube' | 'vk',
        credentialRevision: token.credentialRevision,
        accessToken: token.accessToken,
        providerAccountId: token.providerAccountId,
        scopes: token.scopes,
        getAccessToken: async (options) => {
          if (!options?.forceRefresh) return acceptedAccessToken;
          const refreshed = await input.credentials.getAccessTokenSnapshot(
            publication.userId,
            publication.publishingAccountId,
            { forceRefresh: true, expectedCredentialRevision: acceptedRevision },
          );
          if (
            refreshed.credentialRevision !== acceptedRevision + 1 ||
            refreshed.providerAccountId !== token.providerAccountId
          )
            throw new PublicationPreflightError(
              'reauthorization_required',
              'CREDENTIAL_GENERATION_CHANGED',
              'Credential changed outside the accepted refresh lifecycle',
            );
          acceptedRevision = refreshed.credentialRevision;
          acceptedAccessToken = refreshed.accessToken;
          return acceptedAccessToken;
        },
      },
    };
  };
}
