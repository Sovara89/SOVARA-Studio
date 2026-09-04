// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '../../test/setup';
import { PublicationComposer } from './PublicationComposer';
import { createIntent, listAccounts, listPublicationStatus, publishIntent, retryPublication, startVkOAuth, startYouTubeOAuth, updateIntent } from './publication-api';

vi.mock('./publication-api', () => ({ createIntent: vi.fn(), listAccounts: vi.fn(), listPublicationStatus: vi.fn(), removePreview: vi.fn(), retryPublication: vi.fn(), uploadPreview: vi.fn(), publishIntent: vi.fn(), startVkOAuth: vi.fn(), startYouTubeOAuth: vi.fn(), updateIntent: vi.fn() }));

const intent = { id: 'c4c4e30-e24e-4cde-9534-a43f4b3f98e8', videoId: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8', platform: 'vk' as const, publishingAccountId: '5c4f8e30-e24e-4cde-9534-a43f4b3f98e8', mode: 'DRAFT' as const, title: 'News', description: null, link: null, createCommunityPost: false, scheduledAt: null, preview: null, revision: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('PublicationComposer', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    vi.mocked(listAccounts).mockResolvedValue([{ id: intent.publishingAccountId, platform: 'vk', displayName: 'VK', status: 'active' }]);
    vi.mocked(listPublicationStatus).mockResolvedValue([]);
    vi.mocked(createIntent).mockResolvedValue(intent);
    vi.mocked(updateIntent).mockResolvedValue(intent);
  });

  test('shows the existing VK default link only after VK is selected', () => {
    render(<PublicationComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'VK Video' }));
    expect(screen.getByLabelText('Ссылка в метаданных VK (необязательно)')).toHaveValue('https://vk.com/sovara_news');
  });

  test('saves an intentional VK link clear without publishing', async () => {
    render(<PublicationComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'VK Video' }));
    fireEvent.change(await screen.findByLabelText('Аккаунт VK'), { target: { value: intent.publishingAccountId } });
    fireEvent.change(screen.getByLabelText('Ready Video ID'), { target: { value: intent.videoId } });
    fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'News' } });
    fireEvent.change(screen.getByLabelText('Ссылка в метаданных VK (необязательно)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    await waitFor(() => expect(createIntent).toHaveBeenCalledWith(expect.objectContaining({ link: null, mode: 'DRAFT' })));
    expect(screen.getByText(/Публикация не запускалась/)).toBeInTheDocument();
  });

  test('uses the just-uploaded ready video ID in technical settings', async () => {
    render(<PublicationComposer readyVideoId={intent.videoId} />);
    expect(await screen.findByLabelText('Ready Video ID')).toHaveValue(intent.videoId);
  });

  test('starts YouTube OAuth and refreshes accounts after return', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as never);
    vi.mocked(startYouTubeOAuth).mockResolvedValue({ authorizationUrl: 'https://accounts.google.test/auth' });
    vi.mocked(listAccounts).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: intent.publishingAccountId, platform: 'youtube', displayName: 'YouTube', status: 'active' }]);
    render(<PublicationComposer />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Подключить', hidden: true })[0]!);
    await waitFor(() => expect(startYouTubeOAuth).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByLabelText('Аккаунт YouTube')).toHaveTextContent('YouTube'));
  });

  test('starts VK OAuth and refreshes accounts after return', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as never);
    vi.mocked(startVkOAuth).mockResolvedValue({ authorizationUrl: 'https://id.vk.test/auth' });
    vi.mocked(listAccounts).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: intent.publishingAccountId, platform: 'vk', displayName: 'VK', status: 'active' }]);
    render(<PublicationComposer />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Подключить', hidden: true })[1]!);
    await waitFor(() => expect(startVkOAuth).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByLabelText('Аккаунт VK')).toHaveTextContent('VK'));
  });

  test('saves and publishes a READY video through one explicit action', async () => {
    vi.mocked(publishIntent).mockResolvedValue({ publicationId: intent.id });
    render(<PublicationComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'VK Video' }));
    fireEvent.change(await screen.findByLabelText('Аккаунт VK'), { target: { value: intent.publishingAccountId } });
    fireEvent.change(screen.getByLabelText('Ready Video ID'), { target: { value: intent.videoId } });
    fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'News' } });
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать сейчас' }));
    fireEvent.click(screen.getByRole('button', { name: 'Обрабатываем…' }));
    await waitFor(() => expect(createIntent).toHaveBeenCalledOnce());
    expect(createIntent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'DRAFT', publishingAccountId: intent.publishingAccountId }));
    await waitFor(() => expect(publishIntent).toHaveBeenCalledWith(intent.id, intent.revision));
    expect(publishIntent).toHaveBeenCalledOnce();
    expect(screen.getByText('Публикация поставлена в очередь.')).toBeInTheDocument();
  });

  test('shows field errors and does not save an incomplete publication', async () => {
    render(<PublicationComposer readyVideoId={intent.videoId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать сейчас' }));
    expect(await screen.findByText('Введите заголовок.')).toBeInTheDocument();
    expect(screen.getByText('Выберите аккаунт в настройках.')).toBeInTheDocument();
    expect(createIntent).not.toHaveBeenCalled();
  });

  test('offers a revision-bound retry only for failed publication', async () => {
    const failed = { id: intent.id, videoId: intent.videoId, platform: 'youtube' as const, publishingAccountId: intent.publishingAccountId, state: 'failed' as const, attemptCount: 2, revision: 7, nextAttemptAt: null, publishedAt: null, result: null, error: { code: 'PROVIDER_REJECTED', message: 'Publication failed.', retryable: true }, updatedAt: '2026-01-01T00:00:00.000Z' };
    vi.mocked(listPublicationStatus).mockResolvedValue([failed]);
    vi.mocked(retryPublication).mockResolvedValue({ ...failed, state: 'queued', revision: 8 });
    render(<PublicationComposer />);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить публикацию' }));
    await waitFor(() => expect(retryPublication).toHaveBeenCalledWith(failed.id, 7));
  });

  test('shows an account display name or a neutral fallback in publication status', async () => {
    const status = { id: intent.id, videoId: intent.videoId, platform: 'youtube' as const, publishingAccountId: intent.publishingAccountId, state: 'published' as const, attemptCount: 1, revision: 1, nextAttemptAt: null, publishedAt: '2026-01-01T00:00:00.000Z', result: null, error: null, updatedAt: '2026-01-01T00:00:00.000Z' };
    vi.mocked(listAccounts).mockResolvedValue([{ id: intent.publishingAccountId, platform: 'youtube', displayName: 'Studio channel', status: 'active' }]);
    vi.mocked(listPublicationStatus).mockResolvedValue([status]);
    render(<PublicationComposer />);
    expect(await screen.findByText('Аккаунт: Studio channel')).toBeInTheDocument();
    expect(screen.queryByText(intent.publishingAccountId)).not.toBeInTheDocument();

    cleanup();
    vi.mocked(listAccounts).mockResolvedValue([]);
    render(<PublicationComposer />);
    expect(await screen.findByText('Аккаунт: Подключённый аккаунт')).toBeInTheDocument();
  });

  test('restores the saved account separately for YouTube and VK', async () => {
    window.localStorage.setItem('sovara-studio:publishing-account:youtube', 'youtube-last');
    window.localStorage.setItem('sovara-studio:publishing-account:vk', 'vk-last');
    vi.mocked(listAccounts).mockResolvedValue([
      { id: 'youtube-first', platform: 'youtube', displayName: 'YouTube first', status: 'active' },
      { id: 'youtube-last', platform: 'youtube', displayName: 'YouTube last', status: 'active' },
      { id: 'vk-first', platform: 'vk', displayName: 'VK first', status: 'active' },
      { id: 'vk-last', platform: 'vk', displayName: 'VK last', status: 'active' },
    ]);
    render(<PublicationComposer />);
    expect(await screen.findByLabelText('Аккаунт YouTube')).toHaveValue('youtube-last');
    fireEvent.click(screen.getByRole('button', { name: 'VK Video' }));
    expect(screen.getByLabelText('Аккаунт VK')).toHaveValue('vk-last');
  });

  test('falls back to the first active account when the saved account is unavailable', async () => {
    window.localStorage.setItem('sovara-studio:publishing-account:youtube', 'youtube-inactive');
    vi.mocked(listAccounts).mockResolvedValue([
      { id: 'youtube-inactive', platform: 'youtube', displayName: 'Inactive', status: 'inactive' },
      { id: 'youtube-active', platform: 'youtube', displayName: 'Active', status: 'active' },
    ]);
    render(<PublicationComposer />);
    expect(await screen.findByLabelText('Аккаунт YouTube')).toHaveValue('youtube-active');
  });
});
