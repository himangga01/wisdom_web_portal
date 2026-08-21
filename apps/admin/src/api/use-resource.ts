import { useCallback, useEffect, useRef, useState } from "react";

import { apiRequest, type RuntimeSchema } from "./client";

export function useResource<T>(path: string, schema: RuntimeSchema<T>) {
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
      const nextData = await apiRequest(path, schema, { signal: controller.signal });
      if (!controller.signal.aborted) setData(nextData);
    } catch (nextError) {
      if (!controller.signal.aborted) setError(nextError);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [path, schema]);
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
