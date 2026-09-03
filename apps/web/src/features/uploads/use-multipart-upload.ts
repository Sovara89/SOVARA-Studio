import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createUploadApi } from '../../lib/upload-api';
import { uploadPartDirectly } from '../../lib/s3-upload-transport';
import { UploadCoordinator } from './upload-coordinator';
import { initialUploadMachineState, uploadMachineReducer } from './upload-machine';
import { createUploadSessionStorage } from './upload-session-storage';

export function useMultipartUpload() {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(uploadMachineReducer, initialUploadMachineState);
  const [savedSession, setSavedSession] =
    useState<
      ReturnType<typeof createUploadSessionStorage> extends { load: () => infer T } ? T : never
    >(null);
  const sessions = useMemo(() => createUploadSessionStorage(), []);
  const coordinator = useMemo(
    () =>
      new UploadCoordinator({
        api: createUploadApi(),
        transport: uploadPartDirectly,
        sessions,
        dispatch,
      }),
    [sessions],
  );

  useEffect(() => {
    setSavedSession(sessions.load());
    return () => coordinator.dispose();
  }, [coordinator, sessions]);

  const selectAndStart = useCallback(
    (file: File) => {
      setSavedSession(null);
      void coordinator.start(file).finally(() => setSavedSession(sessions.load()));
    },
    [coordinator, sessions],
  );
  const resumeSelected = useCallback(
    (file: File) => {
      const session = savedSession ?? sessions.load();
      void coordinator.resume(file, session).finally(() => setSavedSession(sessions.load()));
    },
    [coordinator, savedSession, sessions],
  );
  const pause = useCallback(() => coordinator.pause(), [coordinator]);
  const resume = useCallback(
    (file?: File) => {
      if (file) resumeSelected(file);
      else if (state.file) resumeSelected(state.file);
    },
    [coordinator, resumeSelected, state.file],
  );
  const retry = useCallback(
    () => void coordinator.retry().finally(() => setSavedSession(sessions.load())),
    [coordinator, sessions],
  );
  const cancel = useCallback(
    () =>
      void coordinator.cancel().finally(() => {
        setSavedSession(sessions.load());
        queryClient.invalidateQueries();
      }),
    [coordinator, queryClient, sessions],
  );

  return {
    state,
    savedSession,
    selectAndStart,
    resumeSelected,
    pause,
    resume,
    retry,
    cancel,
  };
}
