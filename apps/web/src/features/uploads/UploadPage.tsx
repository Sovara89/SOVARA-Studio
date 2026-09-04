import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { useMultipartUpload } from './use-multipart-upload';
import { PublicationComposer } from '../publications/PublicationComposer';

function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  const units = ['КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let amount = value;
  let unit = 'Б';
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(1)} ${unit}`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  return minutes > 0 ? `${minutes} мин ${remainder} с` : `${remainder} с`;
}

function uploadPhaseText(phase: string) {
  const phases: Record<string, string> = {
    creating: 'Подготавливаем загрузку',
    uploading: 'Загружаем видео',
    paused: 'Загрузка приостановлена',
    retry_wait: 'Ожидаем повторной попытки',
    all_parts_recorded: 'Завершаем загрузку',
    completing: 'Проверяем видео',
    ready: 'Видео готово к публикации',
    cleanup_pending: 'Ожидается очистка',
    failed: 'Загрузка не завершена',
    aborted: 'Загрузка отменена',
  };
  return phases[phase] ?? 'Загрузка видео';
}

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const sample = useRef({ bytes: 0, at: Date.now() });
  const [speed, setSpeed] = useState<number>();
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
    state.confirmedBytes + Object.values(state.inFlightBytes).reduce((sum, value) => sum + value, 0),
  );
  const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
  const recorded = Object.values(state.parts).filter((part) => part.phase === 'recorded').length;
  const canPause = state.phase === 'uploading' || state.phase === 'retry_wait';
  const remaining = Math.max(0, total - transferred);
  useEffect(() => {
    const now = Date.now();
    const elapsed = now - sample.current.at;
    const progressed = transferred - sample.current.bytes;
    if (progressed > 0 && elapsed > 0) setSpeed((progressed * 1000) / elapsed);
    if (transferred === 0 || state.phase !== 'uploading') setSpeed(undefined);
    sample.current = { bytes: transferred, at: now };
  }, [state.phase, transferred]);
  const eta = speed && remaining > 0 ? remaining / speed : undefined;
  return (
    <main className="studio-shell">
      <section className="panel" aria-labelledby="upload-heading">
        <div className="panel-header">
          <div><h2 id="upload-heading">Загрузка видео</h2><p>Добавьте видео. Studio загрузит и подготовит его к публикации.</p></div>
          {state.file && <span className="badge pending">1 файл</span>}
        </div>
        <div className="panel-body">
          <label className="file-picker" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <button type="button" onClick={(event) => { event.preventDefault(); inputRef.current?.click(); }}>Выбрать файл</button>
            <span className="file-name">
              {state.file ? state.file.name : savedSession ? 'Выберите исходный файл для продолжения' : 'Перетащите видео сюда или выберите файл'}
              {state.file && <span>{formatBytes(state.file.size)}</span>}
            </span>
            <input ref={inputRef} type="file" accept="video/*,.mkv,.avi" onChange={onChange} />
          </label>
          {savedSession && !state.file && <p className="notice">Найдена сохранённая загрузка. Выберите исходный файл, чтобы продолжить.</p>}
          {state.status && (
            <div className="progress-box">
              <div className="progress-top">
                <div><strong>{uploadPhaseText(state.phase)}</strong><span className="muted">{recorded} из {state.status.expectedPartCount} частей подтверждено</span></div>
                {eta && <div className="eta"><b>≈ {formatDuration(eta)}</b><small>осталось</small></div>}
              </div>
              <div className="progress-track" aria-label={`Загрузка: ${percent}%`}>
                <div className="progress-fill" style={{ width: `${percent}%` }} />
                <span className="progress-value">{percent}%</span>
              </div>
              <div className="upload-stats">
                <div className="stat"><span>Загружено</span><b>{formatBytes(transferred)}</b></div>
                <div className="stat"><span>Осталось</span><b>{formatBytes(remaining)}</b></div>
                {speed && <div className="stat"><span>Скорость</span><b>{formatBytes(speed)}/с</b></div>}
                {eta && <div className="stat"><span>ETA</span><b>{formatDuration(eta)}</b></div>}
              </div>
            </div>
          )}
          {state.error && <p className="notice" role="alert">{state.error.message}</p>}
          <div className="actions upload-controls">
            {canPause && <button type="button" onClick={uploader.pause}>Приостановить</button>}
            {state.phase === 'paused' && state.file && <button type="button" onClick={() => uploader.resume(state.file)}>Продолжить</button>}
            {(state.phase === 'failed' || state.phase === 'cleanup_pending') && <button type="button" onClick={uploader.retry}>Повторить</button>}
            {['creating', 'uploading', 'paused', 'retry_wait', 'cleanup_pending'].includes(state.phase) && <button className="danger" type="button" onClick={() => void uploader.cancel()}>Отменить загрузку</button>}
          </div>
        </div>
      </section>
      <PublicationComposer readyVideoId={state.phase === 'ready' ? state.videoId : undefined} />
    </main>
  );
}
