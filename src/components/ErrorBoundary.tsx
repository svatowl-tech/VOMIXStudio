import React, { Component, ErrorInfo, ReactNode } from 'react';
import { systemLogger } from '../services/SystemLogger';
import { RefreshCw, AlertTriangle, Trash2 } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    systemLogger.error('System', `Критическая ошибка интерфейса: ${error.message}`, {
      error: error.toString(),
      stack: errorInfo.componentStack
    });
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
            <div className="flex items-center space-x-4 mb-6">
              <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                <AlertTriangle size={24} />
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-100">Ошибка интерфейса</h1>
                <p className="text-xs text-slate-400">VOMIXStudio перехватил сбой рендеринга</p>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-4 mb-6 max-h-36 overflow-y-auto font-mono text-xs text-red-300">
              {this.state.error && this.state.error.toString()}
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 flex items-center justify-center space-x-2 px-4 py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-sm rounded-xl transition-all shadow-lg shadow-cyan-900/20 cursor-pointer"
              >
                <RefreshCw size={16} />
                <span>Перезагрузить</span>
              </button>
              <button
                onClick={() => {
                  localStorage.clear();
                  indexedDB.databases?.().then((dbs) => {
                    (dbs || []).forEach((db) => db && db.name && indexedDB.deleteDatabase(db.name));
                  }).catch(() => {});
                  window.location.reload();
                }}
                className="flex items-center justify-center space-x-2 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-sm rounded-xl transition-all cursor-pointer"
                title="Очистить кэш и базу"
              >
                <Trash2 size={16} />
                <span>Сброс</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
