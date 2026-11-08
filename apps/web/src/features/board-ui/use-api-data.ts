"use client";

// API 取得フック（依存配列が変わったときだけ再取得）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface ApiState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

export function useApiData<T>(loader: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((value) => {
        if (alive) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}

export function errorMessage(error: Error | null): string {
  if (!error) return "";
  if (error instanceof ApiError && error.notImplemented) {
    return "API が未実装です（バックエンドの実装待ち）。";
  }
  return error.message;
}