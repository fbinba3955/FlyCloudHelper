import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 加载 API 资源并提供可重复调用的刷新能力。 */
export function useApiResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[] = []): ApiResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：保存正在执行的请求，同一资源的重复刷新直接复用该请求。
  const activeRefreshRef = useRef<Promise<void> | null>(null);

  // 调用方通过依赖数组声明 loader 何时需要重新生成。
  const refresh = useCallback((): Promise<void> => {
    if (activeRefreshRef.current) return activeRefreshRef.current;

    const activeRefresh = (async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setData(await loader());
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "请求失败");
      } finally {
        setLoading(false);
      }
    })();
    activeRefreshRef.current = activeRefresh;
    void activeRefresh.finally(() => {
      if (activeRefreshRef.current === activeRefresh) activeRefreshRef.current = null;
    });
    return activeRefresh;
  }, dependencies);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
