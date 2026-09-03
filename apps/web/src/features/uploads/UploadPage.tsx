import { useRef, type DragEvent, type ChangeEvent } from 'react';
import { useMultipartUpload } from './use-multipart-upload';
import { PublicationComposer } from '../publications/PublicationComposer';

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 'B';
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(1)} ${unit}`;
}

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploader = useMultipartUpload();
  const { state, savedSession } = uploader;
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (savedSession) uploader.resumeSelected(file);
    else uploader.selectAndStart(file);
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>) => onFile(event.target.files?.[0]);
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    onFile(event.dataTransfer.files[0]);
  };
  const total = state.status?.expectedSizeBytes ?? state.file?.size ?? 0;
  const transferred = Math.min(
    total,
    state.confirmedBytes +
      Object.values(state.inFlightBytes).reduce((sum, value) => sum + value, 0),
  );
  const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
  const recorded = Object.values(state.parts).filter((part) => part.phase === 'recorded').length;
  const canPause = state.phase === 'uploading' || state.phase === 'retry_wait';
  return (
    <section>
      <h1>SOVARA Studio</h1>
      <label onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <span>
          {savedSession ? 'Select the original file to resume' : 'Choose or drop a video file'}
        </span>
        <input ref={inputRef} type="file" accept="video/*,.mkv,.avi" onChange={onChange} />
      </label>
      {state.file && (
        <p>
          {state.file.name} — {formatBytes(state.file.size)}
        </p>
      )}
      {savedSession && !state.file && (
        <p>
          Stored upload session found. Reselect the original file; size and sampled identity will be
          checked.
        </p>
      )}
      {state.status && (
        <>
          <p data-testid="upload-state">{state.phase}</p>
          <progress max={100} value={percent} />
          <p>
            {percent}% · {recorded} / {state.status.expectedPartCount} parts recorded
          </p>
        </>
      )}
      {state.error && <p role="alert">{state.error.message}</p>}
      {canPause && (
        <button type="button" onClick={uploader.pause}>
          Pause
        </button>
      )}
      {state.phase === 'paused' && state.file && (
        <button type="button" onClick={() => uploader.resume(state.file)}>
          Resume
        </button>
      )}
      {(state.phase === 'failed' || state.phase === 'cleanup_pending') && (
        <button type="button" onClick={uploader.retry}>
          Retry
        </button>
      )}
      {['creating', 'uploading', 'paused', 'retry_wait', 'cleanup_pending'].includes(
        state.phase,
      ) && (
        <button type="button" onClick={() => void uploader.cancel()}>
          Cancel / abort
        </button>
      )}
      {state.phase === 'all_parts_recorded' && (
        <p>All parts uploaded and recorded; final completion and verification have not run.</p>
      )}
      <PublicationComposer />
    </section>
  );
}
