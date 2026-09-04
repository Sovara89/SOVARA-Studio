// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import '../../test/setup';
import { UploadPage } from './UploadPage';

vi.mock('./use-multipart-upload', () => ({
  useMultipartUpload: () => ({
    savedSession: null,
    selectAndStart: vi.fn(), resumeSelected: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), cancel: vi.fn(),
    state: { phase: 'ready', videoId: 'ready-video-id', confirmedBytes: 42, inFlightBytes: {}, parts: {}, file: new File(['x'], 'video.mp4'), status: { expectedSizeBytes: 42, expectedPartCount: 1 } },
  }),
}));
vi.mock('../publications/PublicationComposer', () => ({ PublicationComposer: ({ readyVideoId }: { readyVideoId?: string }) => <div>Видео для публикации: {readyVideoId}</div> }));

describe('UploadPage', () => {
  test('shows real upload totals and passes the ready video to publication', () => {
    render(<UploadPage />);
    expect(screen.getByText('Загружено')).toBeInTheDocument();
    expect(screen.getByText('Осталось')).toBeInTheDocument();
    expect(screen.getByText('Видео готово к публикации')).toBeInTheDocument();
    expect(screen.getByText('Видео для публикации: ready-video-id')).toBeInTheDocument();
  });
});
