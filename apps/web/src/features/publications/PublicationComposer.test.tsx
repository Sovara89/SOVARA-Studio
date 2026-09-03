// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '../../test/setup';
import { PublicationComposer, vkMetadataLinkForSave } from './PublicationComposer';
import { createIntent, listAccounts, listPublicationStatus } from './publication-api';

vi.mock('./publication-api', () => ({
  createIntent: vi.fn(),
  listAccounts: vi.fn(),
  listPublicationStatus: vi.fn(),
  removePreview: vi.fn(),
  uploadPreview: vi.fn(),
}));

const intent = {
  id: 'c4c4e30-e24e-4cde-9534-a43f4b3f98e8',
  videoId: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  platform: 'vk' as const,
  publishingAccountId: '5c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  mode: 'DRAFT' as const,
  title: 'News',
  description: null,
  link: null,
  createCommunityPost: false,
  scheduledAt: null,
  preview: null,
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('PublicationComposer VK metadata link', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(listAccounts).mockResolvedValue([
      { id: intent.publishingAccountId, platform: 'vk', displayName: 'VK', status: 'active' },
    ]);
    vi.mocked(listPublicationStatus).mockResolvedValue([]);
    vi.mocked(createIntent).mockResolvedValue(intent);
  });

  test('starts a new VK draft with the exact default link', async () => {
    render(<PublicationComposer />);
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'vk' } });
    expect(await screen.findByLabelText('VK metadata link (optional)')).toHaveValue(
      'https://vk.com/sovara_news',
    );
  });

  test('saves an intentional VK link clear without invoking publication behavior', async () => {
    render(<PublicationComposer />);
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'vk' } });
    fireEvent.change(await screen.findByLabelText('Account'), {
      target: { value: intent.publishingAccountId },
    });
    fireEvent.change(screen.getByLabelText('Ready video ID'), {
      target: { value: intent.videoId },
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'News' } });
    fireEvent.change(screen.getByLabelText('VK metadata link (optional)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(createIntent).toHaveBeenCalledWith(
        expect.objectContaining({ link: null, mode: 'DRAFT' }),
      ),
    );
    expect(screen.getByText(/No publication has been started/)).toBeInTheDocument();
  });

  test('maps blank-only link input to a persisted clear', () => {
    expect(vkMetadataLinkForSave('  ')).toBeNull();
  });
});
