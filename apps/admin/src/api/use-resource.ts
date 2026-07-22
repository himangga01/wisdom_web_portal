import { useCallback, useEffect, useRef, useState } from "react";

import { apiRequest } from "./client";

export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [resolvedPath, setResolvedPath] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setResolvedPath(path);
    setLoading(true);
    setError(undefined);
    setData(undefined);
    try {
      const nextData = await apiRequest<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted) setData(nextData);
    } catch (nextError) {
      if (!controller.signal.aborted) setError(nextError);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
    return () => activeRequest.current?.abort();
  }, [load]);
  const current = resolvedPath === path;
  return {
    data: current ? data : undefined,
    error: current ? error : undefined,
    loading: current ? loading : true,
    reload: load,
  };
}
