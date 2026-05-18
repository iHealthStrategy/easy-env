import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

interface Props<T> {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  emptyMessage?: string;
  empty?: (data: T) => boolean;
}

// Centralises loading / error / empty handling so individual pages can focus
// on rendering data.
export function QueryState<T>({ query, children, emptyMessage, empty }: Props<T>) {
  if (query.isPending) return <div className="loading">加载中…</div>;
  if (query.isError) {
    const err = query.error as Error;
    return <div className="error-banner">加载失败:{err.message}</div>;
  }
  const data = query.data as T;
  if (empty && empty(data)) {
    return <div className="empty">{emptyMessage ?? '暂无数据。'}</div>;
  }
  return <>{children(data)}</>;
}
