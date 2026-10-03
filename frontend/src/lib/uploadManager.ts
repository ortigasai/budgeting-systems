import { useSyncExternalStore } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { api } from "../api/client";
import { queryClient } from "./queryClient";

export interface UploadTask {
  id: string;
  label: string;
  status: "uploading" | "success" | "error";
  progress: number; // 0-100
  message?: string;
  errors?: { row: number; error: string }[];
  startedAt: number;
}

// A plain module-level store, not a React Context - so it outlives whichever
// component started an upload. Axios never cancels a request just because
// the component that triggered it unmounts; the only thing missing before
// this existed was somewhere durable for the progress/result to land, which
// is what makes an upload (and its eventual toast) survive navigating away
// mid-upload. See UploadStatusStack.tsx for the persistent UI this backs,
// mounted once in App.tsx.
const tasks = new Map<string, UploadTask>();
const subscribers = new Set<() => void>();

// useSyncExternalStore requires getSnapshot to return the same reference
// when nothing changed, or it re-renders forever - so the sorted list is
// cached and only rebuilt here, inside notify(), never inside the snapshot
// getter itself (which React may call on every render).
let listSnapshot: UploadTask[] = [];

function notify() {
  listSnapshot = Array.from(tasks.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function useAllUploadTasks(): UploadTask[] {
  return useSyncExternalStore(
    subscribe,
    () => listSnapshot,
    () => listSnapshot
  );
}

export function useUploadTask(id: string | null): UploadTask | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? tasks.get(id) : undefined),
    () => (id ? tasks.get(id) : undefined)
  );
}

export function dismissUploadTask(id: string) {
  tasks.delete(id);
  notify();
}

export function startUpload<T = { created: number; errors: { row: number; error: string }[] }>(opts: {
  label: string;
  url: string;
  form: FormData;
  invalidateKeys?: QueryKey[];
  onDone?: (data: T) => void;
}): string {
  const id = crypto.randomUUID();
  tasks.set(id, { id, label: opts.label, status: "uploading", progress: 0, startedAt: Date.now() });
  notify();

  api
    .post<T>(opts.url, opts.form, {
      onUploadProgress: (evt) => {
        const progress = evt.total ? Math.round((evt.loaded / evt.total) * 100) : 0;
        const task = tasks.get(id);
        if (task) {
          tasks.set(id, { ...task, progress });
          notify();
        }
      },
    })
    .then((res) => {
      for (const key of opts.invalidateKeys ?? []) queryClient.invalidateQueries({ queryKey: key });
      const data = res.data as unknown as { created?: number; errors?: { row: number; error: string }[] };
      const errors = data.errors ?? [];
      const message =
        errors.length === 0
          ? data.created !== undefined
            ? `Created ${data.created} request(s).`
            : "Uploaded successfully."
          : `Created ${data.created ?? 0} request(s). ${errors.length} row(s) were rejected - see details below.`;
      tasks.set(id, { id, label: opts.label, status: "success", progress: 100, message, errors, startedAt: Date.now() });
      notify();
      opts.onDone?.(res.data);
    })
    .catch((err) => {
      const message = err?.response?.data?.error ?? "Upload failed.";
      tasks.set(id, { id, label: opts.label, status: "error", progress: 0, message, startedAt: Date.now() });
      notify();
    });

  return id;
}
